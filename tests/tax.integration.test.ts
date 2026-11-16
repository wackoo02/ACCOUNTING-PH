// BIR tax engine against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { recordJournal, recordJournalTx, voidOrReverse } from "@/lib/ledger/service";
import { importMasters } from "@/lib/masters/store";
import { approveCash, saveCashTransaction } from "@/lib/bank/cash";
import { classifyJournalLine, recordTaxEntries } from "@/lib/tax/feed";
import { taxLines, tieOut } from "@/lib/tax/ledger";
import { computeReturn } from "@/lib/tax/returns";
import { fileReturn, reopenReturn, saveReturnInputs } from "@/lib/tax/filing";
import { certificates2307, qap, sawt, slsp } from "@/lib/tax/lists";
import { quarter } from "@/lib/tax/periods";
import { qapDat, reliefPurchases, reliefSales } from "@/lib/tax/dat";
import { book } from "@/lib/tax/books";

let org = "", owner = "", accountant = "", bdo = "";
const Y = 2026;
const d = (s: string) => new Date(`${Y}-${s}`);
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const tc = async (code: string) => (await prisma.taxCode.findFirstOrThrow({ where: { organizationId: org, code } })).id;
const row = (r: Awaited<ReturnType<typeof computeReturn>>, key: string) => r.sections.flatMap((s) => s.rows).find((x) => x.key === key);

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "Tax Test Corp", ownerUserId: owner, tin: "123-456-789-00000" })).id;
  await prisma.organization.update({ where: { id: org }, data: { rdoCode: "047", registeredAddress: "1 Ayala Ave, Makati City", zipCode: "1226", requireApproval: false, segregationOfDuties: false } });
  await prisma.membership.create({ data: { userId: accountant, organizationId: org, role: "ACCOUNTANT", approvalLimit: "9000000" } });
  await importMasters("banks", org, owner, [{ code: "BDO", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020", nextCheckNo: 5001 }]);
  await importMasters("vendors", org, owner, [
    { code: "V-1", name: "ABC Realty Corp", tin: "987-654-321-00000", address: "2 Paseo, Makati City" },
    { code: "V-2", name: "Juan Supplies Inc", tin: "111-222-333-00000", address: "Pasig City" },
  ]);
  await importMasters("customers", org, owner, [{ code: "C-1", name: "XYZ Trading", tin: "444-555-666-00000", address: "Cebu City", withholdsTax: true }]);
  bdo = (await prisma.bankAccount.findFirstOrThrow({ where: { organizationId: org, code: "BDO" } })).id;
  await recordJournal({ organizationId: org, userId: owner, date: d("01-01"), memo: "Opening balance", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await acct("1020"), debit: "5000000" }, { accountId: await acct("3010"), credit: "5000000" }] });
});

afterAll(async () => {
  await prisma.taxEntry.deleteMany({ where: { organizationId: org } });
  await prisma.taxReturn.deleteMany({ where: { organizationId: org } });
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.cashTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, accountant] } } });
});

describe("tax engine", () => {
  it("picks up EWT on disbursements and CWT on receipts from cash vouchers", async () => {
    const rent = await saveCashTransaction({ organizationId: org, userId: owner, type: "DISBURSEMENT", bankAccountId: bdo, date: d("01-15"), payee: "ABC Realty", partyType: "VENDOR", partyId: "V-1",
      method: "CHECK", memo: "January rent", reference: "SI 100", withholdingTaxCodeId: await tc("WC100"),
      lines: [{ accountId: await acct("6030"), amount: "100000" }, { accountId: await acct("1310"), amount: "12000" }], action: "post" });
    expect(rent.withholdingAmount.toString()).toBe("5600"); // 5% of the lines incl. VAT as the voucher computes it
    const coll = await saveCashTransaction({ organizationId: org, userId: owner, type: "RECEIPT", bankAccountId: bdo, date: d("02-10"), payee: "XYZ", partyType: "CUSTOMER", partyId: "C-1",
      method: "CHECK", memo: "Collection", withholdingTaxCodeId: await tc("WC160"), withholdingAmount: "2000", lines: [{ accountId: await acct("1100"), amount: "112000" }], action: "post" });
    expect(coll.status).toBe("POSTED");
    const ewt = await taxLines(org, d("01-01"), d("03-31"), { kinds: ["EWT"] });
    expect(ewt).toHaveLength(1);
    expect(ewt[0]).toMatchObject({ atcCode: "WC100", base: 10000000n, tax: 560000n });
    expect(ewt[0].party.tin).toBe("987-654-321-00000");
    const cwt = await taxLines(org, d("01-01"), d("03-31"), { kinds: ["CWT"] });
    expect(cwt[0]).toMatchObject({ atcCode: "WC160", base: 11200000n, tax: 200000n });
  });

  it("feeds sales from a sub-ledger and lists unexplained GL tax lines", async () => {
    // What the AR module will do: post the invoice and feed its VAT in the same transaction.
    await prisma.$transaction(async (tx) => {
      const e = await recordJournalTx(tx, { organizationId: org, userId: owner, date: d("02-01"), memo: "SI 0001 XYZ", source: "SALES", sourceId: "inv-1", action: "post",
        lines: [{ accountId: await acct("1100"), debit: "224000", partyType: "CUSTOMER", partyId: "C-1" }, { accountId: await acct("4010"), credit: "200000" }, { accountId: await acct("2030"), credit: "24000" }] });
      await recordTaxEntries(tx, { organizationId: org, userId: owner, journalEntryId: e.id, source: "SALES", sourceId: "inv-1", entries: [
        { kind: "OUTPUT_VAT", ref: "1", date: d("02-01"), taxBase: "150000", taxAmount: "18000", rate: 12, vatClass: "VATABLE", docType: "SI", docNumber: "0001", party: { type: "CUSTOMER", id: "C-1" } },
        { kind: "OUTPUT_VAT", ref: "2", date: d("02-01"), taxBase: "50000", taxAmount: "6000", rate: 12, vatClass: "GOVERNMENT", docType: "SI", docNumber: "0001", party: { type: "CUSTOMER", id: "C-1" } },
      ] });
    });
    // A manual journal with output VAT and an exempt sale nobody classified yet.
    await recordJournal({ organizationId: org, userId: owner, date: d("03-05"), memo: "Cash sale", reference: "SI 0002", action: "post",
      lines: [{ accountId: await acct("1010"), debit: "56000" }, { accountId: await acct("4020"), credit: "50000" }, { accountId: await acct("2030"), credit: "6000" }] });
    const t = await tieOut(org, d("01-01"), d("03-31"));
    const un = t.unexplained.map((u) => `${u.kind}:${u.amount}`).sort();
    expect(un).toEqual(["INPUT_VAT:1200000", "OUTPUT_VAT:600000"]);
    const out = t.unexplained.find((u) => u.kind === "OUTPUT_VAT")!;
    expect(out.suggestedBase).toBe(5000000n);
    await classifyJournalLine(org, accountant, out.lineId, { kind: "OUTPUT_VAT", taxBase: "50000", taxAmount: "6000", rate: 12, vatClass: "VATABLE", party: { type: "OTHER", name: "Walk-in customers" } });
    const inp = t.unexplained.find((u) => u.kind === "INPUT_VAT")!;
    await classifyJournalLine(org, accountant, inp.lineId, { kind: "INPUT_VAT", taxBase: "100000", taxAmount: "12000", rate: 12, vatClass: "SERVICES", party: { type: "VENDOR", id: "V-1" } });
    const t2 = await tieOut(org, d("01-01"), d("03-31"));
    expect(t2.unexplained).toHaveLength(0);
    expect(t2.kinds.every((k) => k.difference === 0n)).toBe(true);
  });

  it("computes 2550Q, 1601-EQ and the attachments", async () => {
    const v = await computeReturn(org, "2550Q", Y, 1);
    expect(row(v, "sales.VATABLE")).toMatchObject({ base: 20000000n, tax: 2400000n });
    expect(row(v, "sales.GOVERNMENT")).toMatchObject({ base: 5000000n, tax: 600000n });
    expect(row(v, "buy.SERVICES")).toMatchObject({ base: 10000000n, tax: 1200000n });
    expect(v.taxDue).toBe(1800000n); // 30,000 output - 12,000 input
    const e = await computeReturn(org, "1601EQ", Y, 1);
    expect(row(e, "total")?.tax).toBe(560000n);
    expect(e.warnings.join(" ")).toMatch(/No filed 0619E for January/);

    const q = await qap(org, "1601EQ", Y, 1);
    expect(q.rows).toHaveLength(1);
    const f = { tin: "123-456-789-00000", rdoCode: "047", name: "Tax Test Corp", address: "1 Ayala Ave, Makati City", zipCode: "1226" };
    const dat = qapDat(f, "1601EQ", quarter(Y, 1).to, q.rows);
    expect(dat.split("\r\n")[1]).toBe('D1,1601EQ,1,987654321,0000,"ABC REALTY CORP","","","",03/2026,WC100,5.00,100000.00,5600.00');
    const s = await sawt(org, quarter(Y, 1), "1702Q");
    expect(s.rows[0]).toMatchObject({ tin9: "444555666", atcCode: "WC160", tax: 200000n });
    const l = await slsp(org, quarter(Y, 1));
    expect(l.sales.map((r) => [r.party.name, r.taxable, r.outputTax])).toEqual([["Walk-in customers", 5000000n, 600000n], ["XYZ Trading", 20000000n, 2400000n]]);
    expect(reliefSales(f, quarter(Y, 1).to, l.sales).split("\r\n")[0]).toMatch(/^H,S,"123456789","TAX TEST CORP"/);
    expect(reliefPurchases(f, quarter(Y, 1).to, l.purchases).split("\r\n")[1]).toMatch(/^D,P,"987654321","ABC REALTY CORP",.*,0.00,0.00,100000.00,0.00,0.00,12000.00,123456789,03\/31\/2026$/);
    const c = await certificates2307(org, Y, 1);
    expect(c.payees[0].rows[0].months).toEqual([10000000n, 0n, 0n]);
    const cr = await book(org, "cash-receipts", d("01-01"), d("03-31"));
    expect(cr.map((x) => x.memo)).toContain("Cash sale");
  });

  it("drops reversed entries, files with a VAT closing entry and carries over", async () => {
    const manual = await recordJournal({ organizationId: org, userId: owner, date: d("03-20"), memo: "Big purchase", action: "post",
      lines: [{ accountId: await acct("6060"), debit: "1000000" }, { accountId: await acct("1310"), debit: "120000" }, { accountId: await acct("1020"), credit: "1120000" }] });
    const line = (await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: manual.id, debit: 120000 } })).id;
    await classifyJournalLine(org, accountant, line, { kind: "INPUT_VAT", taxBase: "1000000", taxAmount: "120000", rate: 12, vatClass: "GOODS", party: { type: "VENDOR", id: "V-2" } });
    expect((await computeReturn(org, "2550Q", Y, 1)).carryOver).toBe(10200000n);
    await voidOrReverse(org, owner, manual.id);
    expect((await computeReturn(org, "2550Q", Y, 1)).taxDue).toBe(1800000n);

    await saveReturnInputs(org, accountant, "2550Q", Y, 1, { surcharge: "0" });
    const filed = await fileReturn(org, accountant, "2550Q", Y, 1, { filedAt: d("04-20"), filingRef: "eFPS-123", postClosing: true });
    expect(filed.status).toBe("FILED");
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: filed.journalEntryId! }, include: { lines: { include: { account: true } } } });
    const by = Object.fromEntries(je.lines.map((l) => [l.account.code, `${l.debit}/${l.credit}`]));
    expect(by).toEqual({ "2030": "30000/0", "1310": "0/12000", "2035": "0/18000" });
    // The closing entry is a TAX entry, so it is not "unexplained".
    expect((await tieOut(org, d("01-01"), d("03-31"))).unexplained).toHaveLength(0);
    await expect(saveReturnInputs(org, accountant, "2550Q", Y, 1, {})).rejects.toThrow(/already filed/);
    // Q2 with only purchases: input carried over from Q1 (nil) and excess carried to Q3.
    const q2 = await computeReturn(org, "2550Q", Y, 2);
    expect(row(q2, "carryOver")?.tax).toBe(0n);
    await reopenReturn(org, owner, filed.id);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: je.id }, include: { reversedBy: true } })).reversedBy).not.toBeNull();
  });

  it("estimates 2551Q from revenue for non-VAT companies", async () => {
    const r = await computeReturn(org, "2551Q", Y, 1);
    expect(row(r, "atc.PT010")).toMatchObject({ base: 25000000n, tax: 750000n });
  });
});
