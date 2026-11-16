// Veritus Mobility: Travel / Transport / Sent Package claims through the mobile API, manager and finance
// approval, GL posting by payment source, reimbursements, corporate wallet reconciliation, reports and asset audit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { issueToken } from "@/lib/api/auth";
import { handleMobile } from "@/lib/api/mobile";
import { importMasters } from "@/lib/masters/store";
import { approveCash } from "@/lib/bank/cash";
import { importStatement, statementTemplate } from "@/lib/bank/recon";
import { amountLines, findDuplicates, vatTreatment } from "@/lib/expense/catalog";
import { parseTag } from "@/lib/assets/audit";

let org = "", owner = "", staff = "", boss = "", acct = "";
let ownerTok = "", staffTok = "", bossTok = "", acctTok = "";
let gcash = "", card = "", bdo = "";
const tag = `${Date.now()}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function call(method: string, path: string, token?: string, body?: unknown) {
  const req = new Request(`https://veritus.test/api/mobile/${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleMobile(req, path.split("?")[0]);
  return { status: res.status, data: await res.json() };
}
const je = async (id: string) => prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: { include: { account: true } } } });
const sumBy = (e: Awaited<ReturnType<typeof je>>, code: string, side: "debit" | "credit") => e.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l[side]), 0);

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${tag}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; staff = (await mk("staff")).id; boss = (await mk("boss")).id; acct = (await mk("acct")).id;
  org = (await provisionOrganization({ name: "Mobility Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: staff, organizationId: org, role: "BOOKKEEPER" },
    { userId: boss, organizationId: org, role: "BOOKKEEPER", approvalLimit: "20000" },
    { userId: acct, organizationId: org, role: "ACCOUNTANT" },
  ] });
  await importMasters("dimensions", org, owner, [{ type: "COST_CENTER", code: "CC-SALES", name: "Sales" }, { type: "DEPARTMENT", code: "SALES", name: "Sales" }]);
  await importMasters("employees", org, owner, [
    { code: "E-100", lastName: "Reyes", firstName: "Ana", department: "SALES", email: `boss${tag}@test.local`, costCenter: "CC-SALES" },
    { code: "E-200", lastName: "Cruz", firstName: "Ben", department: "SALES", email: `staff${tag}@test.local`, costCenter: "CC-SALES", supervisorCode: "E-100" },
  ]);
  await importMasters("banks", org, owner, [
    { code: "GCASH", name: "Corporate GCash", kind: "EWALLET", glAccountCode: "1030" },
    { code: "BDO-CA", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020" },
    { code: "VISA", name: "BDO Corporate Visa", kind: "CREDIT_CARD", glAccountCode: "2015" },
  ]);
  const b = async (code: string) => (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
  gcash = await b("GCASH"); card = await b("VISA"); bdo = await b("BDO-CA");
  await importMasters("currencies", org, owner, [{ code: "JPY", name: "Japanese Yen", rateToBase: "0.38" }]);
  ownerTok = (await issueToken(owner, org)).token; staffTok = (await issueToken(staff, org)).token;
  bossTok = (await issueToken(boss, org)).token; acctTok = (await issueToken(acct, org)).token;
});

afterAll(async () => {
  await prisma.pettyCashVoucherLine.deleteMany({ where: { voucher: { organizationId: org } } });
  await prisma.pettyCashVoucher.deleteMany({ where: { organizationId: org } });
  await prisma.receiptImage.deleteMany({ where: { organizationId: org } });
  await prisma.assetScan.deleteMany({ where: { organizationId: org } });
  await prisma.assetAudit.deleteMany({ where: { organizationId: org } });
  await prisma.fixedAsset.deleteMany({ where: { organizationId: org } });
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.bankStatement.deleteMany({ where: { organizationId: org } });
  await prisma.bankMatch.deleteMany({ where: { organizationId: org } });
  await prisma.cashTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.expenseMapping.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, staff, boss, acct] } } });
  await prisma.$disconnect();
});

describe("catalog rules", () => {
  it("treats a receipt without a VAT TIN, a missing receipt and a foreign receipt as non-VAT", () => {
    expect(vatTreatment({ tin: "", vatRegistered: true })).toMatchObject({ vatRegistered: false });
    expect(vatTreatment({ tin: "123-456-789-000", vatRegistered: true })).toMatchObject({ vatRegistered: true, reason: null });
    expect(vatTreatment({ tin: "123-456-789-000", noReceipt: true })).toMatchObject({ vatRegistered: false });
    expect(vatTreatment({ tin: "123-456-789-000", currencyCode: "JPY", baseCurrency: "PHP" })).toMatchObject({ vatRegistered: false });
  });
  it("turns fare, tolls and parking into lines and spots duplicates", () => {
    expect(amountLines("TRANSPORT", { fare: "450", tolls: "50", parking: "" }, "a", "GRAB").map((l) => l.description)).toEqual(["Grab fare", "Grab tolls"]);
    const base = { provider: "GRAB", bookingNumber: "A-1", employeeId: "e", receiptDate: "2026-11-01", total: 100n, docNumber: null, vendorTin: null, imageId: null };
    expect(findDuplicates(base, [{ ...base, id: "x", number: "PCV-1", bookingNumber: "a1" }])[0]).toMatchObject({ strong: true });
    expect(findDuplicates({ ...base, bookingNumber: null }, [{ ...base, id: "x", number: "PCV-1", bookingNumber: null }])[0]).toMatchObject({ strong: false });
  });
  it("reads our QR stickers, links and plain codes", () => {
    expect(parseTag("VFA:FA-0001")).toBe("FA-0001");
    expect(parseTag("https://x.test/assets/FA-0002")).toBe("FA-0002");
    expect(parseTag(" OLD-77 ")).toBe("OLD-77");
  });
});

describe("mobility claims", () => {
  let grab = "", lala = "";

  it("gives the app its modules, payment accounts and the user's employee profile", async () => {
    const s = await call("GET", "mobility/setup", staffTok);
    expect(s.status).toBe(200);
    expect(s.data.me).toMatchObject({ code: "E-200", supervisorCode: "E-100" });
    expect(s.data.modules.map((m: { key: string }) => m.key)).toEqual(["PETTY_CASH", "TRAVEL", "TRANSPORT", "DELIVERY"]);
    expect(s.data.payments.find((p: { key: string }) => p.key === "GCASH").accounts[0].id).toBe(gcash);
    expect(s.data.payments.find((p: { key: string }) => p.key === "MAYA").accounts).toHaveLength(0);
    expect(s.data.transactionTypes.find((t: { key: string }) => t.key === "CLIENT_VISIT").account.code).toBe("6051");
  });

  it("captures a Grab ride paid by corporate GCash: no TIN means non-VAT", async () => {
    const img = await call("POST", "receipts", staffTok, { imageBase64: PNG, mediaType: "image/png", extract: false });
    const body = {
      module: "TRANSPORT", provider: "GRAB", paymentMethod: "GCASH", paymentAccountId: gcash, transactionType: "CLIENT_VISIT",
      bookingNumber: "A-7XK2P9", receiptDate: "2026-11-10", tripAt: "2026-11-10T09:15", purpose: "Client meeting - ABC Corp renewal",
      details: { pickup: "Makati HQ", dropoff: "BGC One Park", distanceKm: "6.2", passenger: "Ben Cruz", clientVisited: "ABC Corp" },
      amounts: { fare: "450", tolls: "50" }, tipAmount: "20", vendorVatRegistered: true, imageId: img.data.imageId,
    };
    const missing = await call("POST", "vouchers/preview", staffTok, { ...body, details: { pickup: "Makati HQ" }, purpose: "" });
    expect(missing.data.errors.join()).toMatch(/business purpose.*drop-off/i);
    const p = await call("POST", "vouchers/preview", staffTok, body);
    expect(p.data).toMatchObject({ ok: true, gross: "500.00", vat: "0.00", tip: "20.00", totalPaid: "520.00", vendorVatRegistered: false });
    expect(p.data.warnings.join()).toMatch(/non-VAT/);
    const v = await call("POST", "vouchers?submit=1", staffTok, body);
    expect(v.status).toBe(201);
    expect(v.data).toMatchObject({ status: "SUBMITTED", module: "TRANSPORT", employee: { code: "E-200" }, vendor: { name: "Grab" } });
    expect(v.data.costCenterId).toBeTruthy(); // from the employee's default
    grab = v.data.id;
  });

  it("lets the supervisor approve (not the claimant), then finance clears and posts Dr expense / Cr GCash", async () => {
    expect((await call("POST", `vouchers/${grab}/approve`, staffTok)).status).toBe(403);
    expect((await call("POST", `vouchers/${grab}/approve`, acctTok)).status).toBe(403);
    const queue = await call("GET", "vouchers?queue=manager", bossTok);
    expect(queue.data.map((x: { id: string }) => x.id)).toContain(grab);
    const a = await call("POST", `vouchers/${grab}/approve`, bossTok);
    expect(a.data.status).toBe("APPROVED");
    expect(a.data.checks.manager.find((c: { key: string }) => c.key === "purpose")).toMatchObject({ ok: true });
    expect((await call("POST", `vouchers/${grab}/clear`, bossTok, {})).status).toBe(403);
    const c = await call("POST", `vouchers/${grab}/clear`, acctTok, {});
    expect(c.data.status).toBe("CLEARED");
    const e = await je(c.data.journal.id);
    expect(e).toMatchObject({ status: "POSTED", source: "EXPENSE_CLAIM", reference: "A-7XK2P9" });
    expect(sumBy(e, "6051", "debit")).toBe(520);
    expect(sumBy(e, "1030", "credit")).toBe(520);
    expect(sumBy(e, "1310", "debit")).toBe(0);
    expect(e.lines.find((l) => l.account.code === "6051")).toMatchObject({ partyType: "EMPLOYEE", partyId: "E-200" });
  });

  it("blocks a duplicate booking number at finance review unless overridden with a note", async () => {
    const v = await call("POST", "vouchers?submit=1", staffTok, {
      module: "TRANSPORT", provider: "GRAB", paymentMethod: "EMPLOYEE", bookingNumber: "a-7xk2p9", receiptDate: "2026-11-10", purpose: "Client meeting",
      details: { pickup: "Makati HQ", dropoff: "BGC" }, amounts: { fare: "450" },
    });
    await call("POST", `vouchers/${v.data.id}/approve`, bossTok);
    const blocked = await call("POST", `vouchers/${v.data.id}/clear`, acctTok, {});
    expect(blocked.status).toBe(422);
    expect(blocked.data.errors.join()).toMatch(/same booking number/);
    const hold = await call("POST", `vouchers/${v.data.id}/hold`, acctTok, { reason: "Checking with Grab" });
    expect(hold.data.status).toBe("HOLD");
    const rej = await call("POST", `vouchers/${v.data.id}/reject`, acctTok, { reason: "Duplicate of the GCash ride" });
    expect(rej.data.status).toBe("REJECTED");
  });

  it("posts an employee-paid Lalamove inventory delivery to Inventory in Transit and the employee payable, then reimburses", async () => {
    const v = await call("POST", "vouchers?submit=1", staffTok, {
      module: "DELIVERY", provider: "LALAMOVE", paymentMethod: "EMPLOYEE", transactionType: "INVENTORY_DELIVERY", bookingNumber: "LLM-889120",
      receiptDate: "2026-11-11", purpose: "Stock transfer to Cebu branch", details: { receiver: "Cebu warehouse", deliveryAddress: "Mandaue City", packageType: "Inventory / goods", weightKg: "35" },
      amounts: { deliveryFee: "1250", additionalCharges: "150" },
    });
    expect(v.data).toMatchObject({ status: "SUBMITTED", totalPaid: "1400.00" });
    lala = v.data.id;
    await call("POST", `vouchers/${lala}/approve`, bossTok);
    const c = await call("POST", `vouchers/${lala}/clear`, acctTok, {});
    const e = await je(c.data.journal.id);
    expect(sumBy(e, "1205", "debit")).toBe(1400);
    expect(sumBy(e, "2018", "credit")).toBe(1400);
    expect(e.lines.find((l) => l.account.code === "2018")).toMatchObject({ partyType: "EMPLOYEE", partyId: "E-200" });

    const out = await call("GET", "reimbursements", acctTok);
    expect(out.data[0]).toMatchObject({ employee: { code: "E-200" }, total: "1400.00", count: 1 });
    const pay = await call("POST", "reimbursements", acctTok, { employeeId: out.data[0].employee.id, bankAccountId: bdo, date: "2026-11-15", method: "BANK_TRANSFER" });
    expect(pay.status).toBe(201);
    expect((await call("POST", "reimbursements", acctTok, { employeeId: out.data[0].employee.id, bankAccountId: bdo })).status).toBe(422);
    await approveCash(org, owner, pay.data.cashTransactionId);
    expect((await call("GET", `vouchers/${lala}`, staffTok)).data.status).toBe("REIMBURSED");
  });

  it("converts an international travel receipt to pesos and keeps the foreign total", async () => {
    const p = await call("POST", "vouchers/preview", staffTok, {
      module: "TRAVEL", transactionType: "TRAVEL_INTERNATIONAL", paymentMethod: "CREDIT_CARD", paymentAccountId: card, receiptDate: "2026-11-12",
      vendorName: "Tokyo Metro", currencyCode: "JPY", fxRate: "0.38", purpose: "Supplier visit", details: { travelType: "INTERNATIONAL", destination: "Tokyo, Japan" },
      lines: [{ description: "Day pass", unitPrice: "3000" }],
    });
    expect(p.data).toMatchObject({ ok: true, gross: "1140.00", vat: "0.00", foreignTotal: "3000.00", currencyCode: "JPY" });
  });

  it("accepts a manual entry with no receipt as non-VAT, with a reason", async () => {
    const base = { module: "TRANSPORT", provider: "ANGKAS", paymentMethod: "EMPLOYEE", receiptDate: "2026-11-13", purpose: "Bank deposit run", details: { pickup: "Office", dropoff: "BDO Ayala" }, amounts: { fare: "120" }, noReceipt: true };
    expect((await call("POST", "vouchers/preview", staffTok, base)).data.errors.join()).toMatch(/why there is no receipt/);
    const p = await call("POST", "vouchers/preview", staffTok, { ...base, noReceiptReason: "App did not send an e-receipt", vendorTin: "123-456-789-000" });
    expect(p.data).toMatchObject({ ok: true, vat: "0.00", totalPaid: "120.00" });
  });
});

describe("corporate wallet reconciliation", () => {
  it("auto-matches the GCash statement to the posted ride and sends an unexplained charge to the employee", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await statementTemplate()) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Statement")!;
    [["2026-11-10", "GRAB A-7XK2P9", "A-7XK2P9", "", 520, "", 9480], ["2026-11-14", "LALAMOVE ORDER 55120", "55120", "", 680, "", 8800]].forEach((r, i) => { ws.getRow(i + 2).values = r; });
    await importStatement({ organizationId: org, userId: acct, bankAccountId: gcash, buf: (await wb.xlsx.writeBuffer()) as ArrayBuffer, openingBalance: "10000", closingBalance: "8800" });

    let r = await call("GET", "reconciliation", acctTok);
    const g = r.data.find((x: { account: { id: string } }) => x.account.id === gcash);
    expect(g).toMatchObject({ unreconciled: 1 });
    expect(g.exceptions).toHaveLength(2);
    expect((await call("POST", `reconciliation/${gcash}/auto`, acctTok)).data.matched).toBe(1);
    r = await call("GET", "reconciliation", acctTok);
    const g2 = r.data.find((x: { account: { id: string } }) => x.account.id === gcash);
    expect(g2).toMatchObject({ reconciled: 1, unreconciled: 0 });
    expect(g2.exceptions).toHaveLength(1);

    const emp = await prisma.employee.findFirstOrThrow({ where: { organizationId: org, code: "E-200" } });
    const ex = await call("POST", "reconciliation/exceptions", acctTok, { statementLineId: g2.exceptions[0].id, employeeId: emp.id, module: "DELIVERY" });
    expect(ex.status).toBe(201);
    const mine = await call("GET", "vouchers?mine=1&status=RETURNED", staffTok);
    const claim = mine.data.find((x: { id: string }) => x.id === ex.data.id);
    expect(claim).toMatchObject({ provider: "LALAMOVE", paymentMethod: "GCASH", grossAmount: "680.00" });
    // The employee completes it; once cleared it posts and clears against the same statement line.
    const fixed = await call("PUT", `vouchers/${claim.id}`, staffTok, {
      module: "DELIVERY", provider: "LALAMOVE", paymentMethod: "GCASH", paymentAccountId: gcash, receiptDate: "2026-11-14", bookingNumber: "55120",
      purpose: "Documents to BIR", details: { receiver: "BIR RDO 47", deliveryAddress: "Makati" }, amounts: { deliveryFee: "680" },
    });
    expect(fixed.data.status).toBe("DRAFT");
    await call("POST", `vouchers/${claim.id}/submit`, staffTok);
    await call("POST", `vouchers/${claim.id}/approve`, bossTok);
    expect((await call("POST", `vouchers/${claim.id}/clear`, acctTok, {})).data.status).toBe("CLEARED");
    const g3 = (await call("GET", "reconciliation", acctTok)).data.find((x: { account: { id: string } }) => x.account.id === gcash);
    expect(g3).toMatchObject({ reconciled: 2, unreconciled: 0, exceptions: [] });
  });
});

describe("reports", () => {
  it("shows KPIs and the expense summary per employee", async () => {
    const d = await call("GET", "reports/dashboard?from=2026-11-01&to=2026-11-30", ownerTok);
    expect(d.data.totals).toMatchObject({ transportation: "520.00", delivery: "2080.00" });
    expect(d.data.topTravelers[0]).toMatchObject({ label: "Ben Cruz", amount: "520.00" });
    expect(d.data.unreconciled).toMatchObject({ claims: 0, exceptions: 0 });
    const r = await call("GET", "reports/employees?from=2026-11-01&to=2026-11-30", ownerTok);
    expect(r.data[0]).toMatchObject({ employee: { code: "E-200" }, total: "2600.00", byModule: { TRANSPORT: "520.00", DELIVERY: "2080.00" } });
  });
});

describe("asset audit", () => {
  it("scans QR stickers, maps an old tag, and marks unscanned assets missing on close", async () => {
    await importMasters("assets", org, owner, [
      { code: "FA-0001", name: "Laptop", category: "IT equipment", location: "HQ", cost: 65000 },
      { code: "FA-0002", name: "Printer", category: "IT equipment", location: "HQ", cost: 18000 },
      { code: "FA-0003", name: "Office chair", category: "Furniture", location: "HQ", cost: 7000 },
    ]);
    const a = await call("POST", "asset-audits", staffTok, { name: "Q4 count", location: "HQ" });
    expect(a.status).toBe(201);
    const s1 = await call("POST", `asset-audits/${a.data.id}/scans`, staffTok, { tagText: "VFA:FA-0001", condition: "GOOD" });
    expect(s1.data).toMatchObject({ scan: { result: "FOUND" }, asset: { code: "FA-0001", lastSeenLocation: "HQ" } });
    const s2 = await call("POST", `asset-audits/${a.data.id}/scans`, staffTok, { tagText: "VFA:FA-0002", location: "Cebu branch", condition: "FOR_REPAIR" });
    expect(s2.data).toMatchObject({ scan: { result: "WRONG_LOCATION" }, asset: { status: "FOR_REPAIR" } });
    const s3 = await call("POST", `asset-audits/${a.data.id}/scans`, staffTok, { tagText: "OLD-77" });
    expect(s3.data.scan.result).toBe("UNKNOWN");
    expect((await call("GET", "assets/lookup?tag=OLD-77", staffTok)).status).toBe(404);
    const fa3 = await prisma.fixedAsset.findFirstOrThrow({ where: { organizationId: org, code: "FA-0003" } });
    expect((await call("POST", "assets/map-tag", staffTok, { tagText: "OLD-77", assetId: fa3.id })).data.tagCode).toBe("OLD-77");
    let sum = (await call("GET", `asset-audits/${a.data.id}`, staffTok)).data;
    expect(sum.totals).toMatchObject({ expected: 3, found: 3, missing: 0, wrongLocation: 1, unknown: 0 });

    const b = await call("POST", "asset-audits", staffTok, { name: "Spot check", location: "HQ" });
    await call("POST", `asset-audits/${b.data.id}/scans`, staffTok, { tagText: "FA-0001" });
    expect((await call("POST", `asset-audits/${b.data.id}/close`, staffTok, {})).status).toBe(403);
    sum = (await call("POST", `asset-audits/${b.data.id}/close`, acctTok, {})).data;
    expect(sum.totals).toMatchObject({ found: 1, missing: 2, missingCost: "25000.00" });
    expect((await prisma.fixedAsset.findFirstOrThrow({ where: { organizationId: org, code: "FA-0003" } })).status).toBe("MISSING");
    expect(sum.byCategory.find((c: { key: string }) => c.key === "Furniture")).toMatchObject({ expected: 1, missing: 1 });
  });
});

describe("sales invoice scanning", () => {
  it("previews and sends a charge sale journal for approval, and refuses the same invoice twice", async () => {
    await importMasters("customers", org, owner, [{ code: "C-001", name: "ABC Corp", tin: "111-222-333-000" }]);
    const cust = await prisma.customer.findFirstOrThrow({ where: { organizationId: org, code: "C-001" } });
    const body = { invoiceNumber: "0451", date: "2026-11-14", terms: "CHARGE", customerId: cust.id, vatableSales: "10000", total: "11200", withholdingTax: "100", isService: true };
    expect((await call("POST", "sales-invoices/preview", staffTok, { ...body, customerId: null })).data.errors.join()).toMatch(/need a customer/);
    const p = await call("POST", "sales-invoices/preview", staffTok, body);
    expect(p.data).toMatchObject({ ok: true, totals: { vat: "1200.00", net: "10000.00", receivable: "11100.00" } });
    const r = await call("POST", "sales-invoices", staffTok, body);
    expect(r.status).toBe(201);
    const e = await je(r.data.journal.id);
    expect(e).toMatchObject({ status: "PENDING_APPROVAL", source: "SALES", reference: "SI 0451" });
    expect(sumBy(e, "1100", "debit")).toBe(11100);
    expect(sumBy(e, "1320", "debit")).toBe(100);
    expect(sumBy(e, "4020", "credit")).toBe(10000);
    expect(sumBy(e, "2030", "credit")).toBe(1200);
    expect((await call("POST", "sales-invoices", staffTok, body)).data.errors.join()).toMatch(/already recorded/);
  });
});
