// Receivables and billing against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { voidOrReverse } from "@/lib/ledger/service";
import { trialBalance } from "@/lib/ledger/reports";
import { importMasters } from "@/lib/masters/store";
import { computeInvoice, advance } from "@/lib/ar/compute";
import {
  applyCredit, approveInvoice, approveReceipt, rejectInvoice, saveInvoice, saveReceipt, saveSeries, submitInvoice, voidInvoice, voidReceipt,
} from "@/lib/ar/service";
import { customerAging, customerStatement } from "@/lib/ar/reports";
import { billMilestone, runBilling, saveContract } from "@/lib/ar/billing";
import { invoicePdf, receiptPdf, statementPdf } from "@/lib/ar/pdf";

let org = "", owner = "", clerk = "", accountant = "";
let xyz = "", abc = "", usdCust = "", bdo = "", usdBank = "", wc160 = "";
const Y = 2026;
const d = (s: string) => new Date(`${Y}-${s}`);
const acctId = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const bal = async (code: string, asOf = d("12-31")) => {
  const tb = await trialBalance(org, asOf);
  const r = tb.rows.find((x) => x.account.code === code);
  return r ? r.closing : 0n;
};

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "AR Test Co", tin: "123-456-789-00000", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: org, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: org, role: "ACCOUNTANT", approvalLimit: "1000000" },
  ] });
  await importMasters("currencies", org, owner, [{ code: "USD", name: "US Dollar", rateToBase: "58" }]);
  await importMasters("accounts", org, owner, [{ code: "1027", name: "Cash in Bank - USD", type: "ASSET", ifrsGroup: "Cash and cash equivalents", isCurrent: true, parentCode: "1000", currencyCode: "USD" }]);
  await importMasters("banks", org, owner, [
    { code: "BDO-CA", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020" },
    { code: "BPI-USD", name: "BPI Dollar", kind: "SAVINGS", glAccountCode: "1027" },
  ]);
  await importMasters("customers", org, owner, [
    { code: "C-XYZ", name: "XYZ Trading Corp.", tin: "000-987-654-00000", paymentTermsDays: 30, creditLimit: "100000", withholdsTax: true, invoiceEmails: "ap@xyz.ph; finance@xyz.ph" },
    { code: "C-ABC", name: "ABC Retail", paymentTermsDays: 15 },
    { code: "C-US", name: "Acme Inc. (USA)", currencyCode: "USD", paymentTermsDays: 30 },
  ]);
  const cust = async (code: string) => (await prisma.customer.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
  xyz = await cust("C-XYZ"); abc = await cust("C-ABC"); usdCust = await cust("C-US");
  bdo = (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code: "BDO-CA" } } })).id;
  usdBank = (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code: "BPI-USD" } } })).id;
  wc160 = (await prisma.taxCode.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code: "WC160" } } })).id;
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.arApplication.deleteMany({ where: { organizationId: org } });
  await prisma.arReceipt.deleteMany({ where: { organizationId: org } });
  await prisma.salesInvoice.deleteMany({ where: { organizationId: org } });
  await prisma.billingContract.deleteMany({ where: { organizationId: org } });
  await prisma.documentSeries.deleteMany({ where: { organizationId: org } });
  await prisma.bankMatch.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
});

describe("invoice arithmetic", () => {
  it("adds 12% VAT on VATable lines and keeps zero-rated and exempt separate", () => {
    const c = computeInvoice([
      { quantity: "2", unitPrice: "1000", vatType: "VATABLE" },
      { quantity: "1", unitPrice: "500", discount: "100", vatType: "ZERO_RATED" },
      { quantity: "3", unitPrice: "33.3333", vatType: "EXEMPT" },
    ], { pricesIncludeVat: false, vatRegistered: true, ewtRatePct: "2" });
    expect(c.vatableSales).toBe(200000n);
    expect(c.vatAmount).toBe(24000n);
    expect(c.zeroRatedSales).toBe(40000n);
    expect(c.exemptSales).toBe(10000n);
    expect(c.total).toBe(274000n);
    expect(c.ewt).toBe(5000n); // 2% of 2,500 (before VAT)
    expect(c.amountDue).toBe(269000n);
  });
  it("splits VAT out of VAT-inclusive prices and balances to the centavo", () => {
    const c = computeInvoice([
      { quantity: "1", unitPrice: "100", vatType: "VATABLE" },
      { quantity: "1", unitPrice: "100", vatType: "VATABLE" },
      { quantity: "1", unitPrice: "100", vatType: "VATABLE" },
    ], { pricesIncludeVat: true, vatRegistered: true });
    expect(c.total).toBe(30000n);
    expect(c.vatableSales).toBe(26786n);
    expect(c.vatAmount).toBe(3214n);
    expect(c.lines.reduce((s, l) => s + l.net, 0n)).toBe(c.vatableSales);
    expect(c.lines.reduce((s, l) => s + l.vat, 0n)).toBe(c.vatAmount);
  });
  it("charges no VAT for a non-VAT seller", () => {
    const c = computeInvoice([{ quantity: "1", unitPrice: "1000", vatType: "VATABLE" }], { pricesIncludeVat: false, vatRegistered: false });
    expect(c.vatAmount).toBe(0n);
    expect(c.exemptSales).toBe(100000n);
  });
  it("keeps the billing day when advancing months", () => {
    expect(advance(new Date("2026-01-31"), "MONTHLY", 31).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(advance(new Date("2026-02-28"), "MONTHLY", 31).toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(advance(new Date("2026-01-15"), "QUARTERLY").toISOString().slice(0, 10)).toBe("2026-04-15");
  });
});

describe("sales invoices", () => {
  let si1 = "", si1No = "";
  it("assigns the BIR serial only when issued, from the registered series", async () => {
    await saveSeries(org, owner, { docType: "SALES_INVOICE", name: "Main SI", startNo: 501, endNo: 503, branchCode: "00000", authorityType: "ATP", authorityNo: "OCN-123", isDefault: true });
    const inv = await saveInvoice({
      organizationId: org, userId: clerk, customerId: xyz, date: d("10-01"), ewtTaxCodeId: wc160, reference: "PO 778", action: "submit",
      lines: [{ description: "IT support October", quantity: "1", unitPrice: "50000", vatType: "VATABLE" }],
    });
    expect(inv.number).toBeNull();
    expect(inv.status).toBe("PENDING_APPROVAL");
    expect(inv.dueDate.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(inv.totalAmount.toString()).toBe("56000");
    expect(inv.ewtAmount.toString()).toBe("1000");
    await expect(approveInvoice(org, clerk, inv.id)).rejects.toThrow(/rights/);
    const posted = await approveInvoice(org, accountant, inv.id);
    expect(posted.number).toBe("000501");
    si1 = inv.id; si1No = posted.number!;
    expect(await bal("1100")).toBe(5600000n);
    expect(await bal("4010")).toBe(-5000000n); // no product: the SALES role account
    expect(await bal("2030")).toBe(-600000n);
  });
  it("returns a draft to the preparer and blocks manual reversal of its GL entry", async () => {
    const inv = await saveInvoice({ organizationId: org, userId: clerk, customerId: abc, date: d("10-05"), action: "submit", lines: [{ description: "Goods", quantity: "10", unitPrice: "112", vatType: "VATABLE" }], pricesIncludeVat: true });
    await rejectInvoice(org, accountant, inv.id, "Wrong price");
    await submitInvoice(org, clerk, inv.id);
    const p = await approveInvoice(org, accountant, inv.id);
    expect(p.number).toBe("000502");
    expect(p.vatAmount.toString()).toBe("120");
    await expect(voidOrReverse(org, owner, p.journalEntryId!)).rejects.toThrow(/Receivables/);
  });
  it("stops when the ATP range is used up", async () => {
    const a = await saveInvoice({ organizationId: org, userId: clerk, customerId: abc, date: d("10-06"), action: "submit", lines: [{ description: "Goods", quantity: "1", unitPrice: "1000", vatType: "VATABLE" }] });
    expect((await approveInvoice(org, accountant, a.id)).number).toBe("000503");
    const b = await saveInvoice({ organizationId: org, userId: clerk, customerId: abc, date: d("10-06"), action: "submit", lines: [{ description: "Goods", quantity: "1", unitPrice: "1000", vatType: "VATABLE" }] });
    await expect(approveInvoice(org, accountant, b.id)).rejects.toThrow(/used up/);
    await saveSeries(org, owner, { docType: "SALES_INVOICE", name: "Second ATP", startNo: 504, endNo: 1000, isDefault: true });
    expect((await approveInvoice(org, accountant, b.id)).number).toBe("000504");
    // Voiding an issued invoice keeps its serial and reverses the GL.
    await voidInvoice(org, owner, b.id, "Cancelled order");
    const v = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: b.id } });
    expect(v.status).toBe("VOID");
    expect(v.number).toBe("000504");
  });

  it("records a collection with tax withheld, applies it and leaves the rest as an advance", async () => {
    // 56,000 invoice; customer pays 54,880 net of 2% EWT (1,000) => 55,880 credit; over-pays by nothing; pay 60,000 -> advance
    const r = await saveReceipt({
      organizationId: org, userId: clerk, customerId: xyz, date: d("10-20"), bankAccountId: bdo, method: "CHECK", checkNo: "778899",
      cashAmount: "59000", withholdingTaxCodeId: wc160, withholdingAmount: "1000", applications: [{ invoiceId: si1, amount: "56000" }], action: "submit",
    });
    expect(r.number).toBeNull();
    const p = await approveReceipt(org, accountant, r.id);
    expect(p.number).toMatch(/^OR-2026-/);
    expect(p.appliedAmount.toString()).toBe("56000");
    expect(await bal("1100")).toBe(5600000n + 112000n + 112000n - 5600000n);
    expect(await bal("1320")).toBe(100000n);
    expect(await bal("2090")).toBe(-400000n); // 4,000 advance
    const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: si1 } });
    expect(inv.appliedAmount.toString()).toBe("56000");

    // A new invoice is paid from the advance.
    const si = await saveInvoice({ organizationId: org, userId: clerk, customerId: xyz, date: d("11-01"), action: "submit", lines: [{ description: "IT support November", quantity: "1", unitPrice: "3000", vatType: "VATABLE" }] });
    await approveInvoice(org, accountant, si.id);
    await applyCredit(org, accountant, { receiptId: r.id }, [{ invoiceId: si.id, amount: "3360" }], d("11-02"));
    expect(await bal("2090")).toBe(-64000n);
    await expect(applyCredit(org, accountant, { receiptId: r.id }, [{ invoiceId: si.id, amount: "1" }], d("11-02"))).rejects.toThrow(/still open/);

    // The aging ties to the GL.
    const ag = await customerAging(org, d("11-30"));
    expect(ag.tieOut!.ar.subledger).toBe(ag.tieOut!.ar.gl!.balance);
    expect(ag.tieOut!.advances.subledger).toBe(ag.tieOut!.advances.gl!.balance);

    // Bounced check: void the collection. Both invoices are open again and the advance is gone.
    await voidReceipt(org, owner, r.id, "Check bounced (DAIF)", d("11-05"));
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: si1 } })).appliedAmount.toString()).toBe("0");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: si.id } })).appliedAmount.toString()).toBe("0");
    expect(await bal("2090")).toBe(0n);
    expect(await bal("1320")).toBe(0n);
    const lines = await prisma.journalLine.findMany({ where: { organizationId: org, accountId: await acctId("1020"), clearedAt: null } });
    expect(lines).toHaveLength(0); // original and reversal offset each other for the bank rec
  });

  it("issues a credit memo against an invoice and ages what is left", async () => {
    const cm = await saveInvoice({
      organizationId: org, userId: clerk, kind: "CREDIT_MEMO", customerId: xyz, date: d("11-10"), creditForId: si1, reason: "Service credit for downtime", action: "submit",
      lines: [{ description: "Service credit", quantity: "1", unitPrice: "5000", vatType: "VATABLE" }],
    });
    const p = await approveInvoice(org, accountant, cm.id);
    expect(p.number).toBe("CM-2026-000001");
    expect(p.appliedAmount.toString()).toBe("5600");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: si1 } })).appliedAmount.toString()).toBe("5600");
    expect(await bal("4030")).toBe(500000n);
    await expect(voidInvoice(org, owner, si1, "x")).rejects.toThrow(/applied/);

    const ag = await customerAging(org, d("12-15"));
    const x = ag.customers.find((c) => c.code === "C-XYZ")!;
    const row = x.rows.find((r) => r.invoiceId === si1)!;
    expect(row.open).toBe(5040000n);
    expect(row.days).toBe(45);
    expect(row.bucket).toBe(2); // 31-60
    expect(ag.tieOut!.ar.subledger).toBe(ag.tieOut!.ar.gl!.balance);

    const st = await customerStatement(org, xyz, d("11-01"), d("12-31"));
    expect(st!.opening).toBe(5600000n);
    expect(st!.closing).toBe(5600000n + 336000n - 560000n + 0n);
  });

  it("collects a dollar invoice with a realized FX gain", async () => {
    const inv = await saveInvoice({ organizationId: org, userId: clerk, customerId: usdCust, date: d("10-01"), fxRate: "56", action: "submit", lines: [{ description: "Export services", quantity: "1", unitPrice: "1000", vatType: "ZERO_RATED" }] });
    await approveInvoice(org, accountant, inv.id);
    const je = await prisma.journalLine.findFirstOrThrow({ where: { journalEntry: { sourceId: inv.id }, accountId: await acctId("1100") } });
    expect(je.debit.toString()).toBe("56000");
    expect(je.fxDebit.toString()).toBe("1000");
    const r = await saveReceipt({ organizationId: org, userId: clerk, customerId: usdCust, date: d("10-30"), bankAccountId: usdBank, method: "BANK_TRANSFER", fxRate: "58", cashAmount: "1000", applications: [{ invoiceId: inv.id, amount: "1000" }], action: "submit" });
    await approveReceipt(org, accountant, r.id);
    expect(await bal("7020")).toBe(-200000n); // 1,000 x (58 - 56)
  });
});

describe("billing", () => {
  it("bills a subscription every month, once per period", async () => {
    const c = await saveContract({
      organizationId: org, userId: owner, kind: "SUBSCRIPTION", name: "Cloud plan", customerId: abc, startDate: d("09-15"), endDate: d("12-14"), frequency: "MONTHLY",
      lines: [{ description: "Cloud plan - 10 seats", quantity: "10", unitPrice: "500", vatType: "VATABLE" }],
    });
    const r1 = await runBilling(org, owner, d("10-20"));
    expect(r1.errors).toEqual([]);
    expect(r1.created.map((x) => x.period)).toEqual(["2026-09-15 to 2026-10-14", "2026-10-15 to 2026-11-14"]);
    expect((await runBilling(org, owner, d("10-20"))).created).toHaveLength(0);
    await runBilling(org, owner, d("12-31"));
    const after = await prisma.billingContract.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.invoiceCount).toBe(3);
    expect(after.status).toBe("ENDED");
    const invs = await prisma.salesInvoice.findMany({ where: { contractId: c.id } });
    expect(invs.every((i) => i.status === "PENDING_APPROVAL" && i.totalAmount.toString() === "5600")).toBe(true);
  });
  it("bills project milestones by percent of the contract value", async () => {
    const c = await saveContract({
      organizationId: org, userId: owner, kind: "PROJECT", name: "ERP rollout", customerId: xyz, startDate: d("10-01"), contractValue: "1000000",
      milestones: [{ description: "Downpayment", percent: "30" }, { description: "Go-live", percent: "70" }],
    });
    await expect(saveContract({ organizationId: org, userId: owner, kind: "PROJECT", name: "Too much", customerId: xyz, startDate: d("10-01"), contractValue: "100", milestones: [{ description: "A", amount: "200" }] })).rejects.toThrow(/more than/);
    const ms = await prisma.billingMilestone.findMany({ where: { contractId: c.id }, orderBy: { lineNo: "asc" } });
    expect(ms[0].amount.toString()).toBe("300000");
    const inv = await billMilestone(org, owner, ms[0].id, d("10-02"));
    expect(inv.totalAmount.toString()).toBe("336000");
    await expect(billMilestone(org, owner, ms[0].id, d("10-02"))).rejects.toThrow(/already billed/);
    await voidInvoice(org, owner, inv.id, "Re-bill");
    expect((await prisma.billingMilestone.findUniqueOrThrow({ where: { id: ms[0].id } })).invoiceId).toBeNull();
  });
});

describe("documents", () => {
  it("renders the BIR invoice, receipt and statement PDFs", async () => {
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { organizationId: org, number: "000501" } });
    const pdf = await invoicePdf(org, inv.id);
    expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.fileName).toBe("SalesInvoice-000501.pdf");
    const r = await prisma.arReceipt.findFirstOrThrow({ where: { organizationId: org, status: "POSTED" } });
    expect(Buffer.from((await receiptPdf(org, r.id)).bytes).subarray(0, 4).toString()).toBe("%PDF");
    expect(Buffer.from((await statementPdf(org, xyz, d("10-01"), d("12-31"))).bytes).subarray(0, 4).toString()).toBe("%PDF");
  });
});
