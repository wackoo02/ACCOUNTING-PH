// Demo data: a parent company and a subsidiary with sample postings. Run: npm run db:seed
// Sign in as owner@demo.ph, accountant@demo.ph or bookkeeper@demo.ph (password: demo12345).
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db";
import { provisionOrganization } from "../src/lib/org";
import { postJournal, recordIntercompany, recordJournal, setupIntercompany } from "../src/lib/ledger/service";
import { importMasters } from "../src/lib/masters/store";
import { approvePo, approvePurchaseRequest, awardRfq, createRfq, recordGoodsReceipt, saveQuote, savePurchaseRequest, submitPurchaseOrder } from "../src/lib/purchasing/service";
import { approveBill, saveBill } from "../src/lib/ap/bills";
import { savePayment } from "../src/lib/ap/payments";
import { approveCash, saveCashTransaction } from "../src/lib/bank/cash";
import { importStatement, statementTemplate } from "../src/lib/bank/recon";
import ExcelJS from "exceljs";

async function main() {
  if (await prisma.user.findUnique({ where: { email: "owner@demo.ph" } })) return console.log("Demo data already present.");
  const hash = await bcrypt.hash("demo12345", 12);
  const mk = (email: string, name: string) => prisma.user.create({ data: { email, name, passwordHash: hash } });
  const owner = await mk("owner@demo.ph", "Demo Owner");
  const acc = await mk("accountant@demo.ph", "Ana Accountant");
  const bk = await mk("bookkeeper@demo.ph", "Ben Bookkeeper");
  const parent = await provisionOrganization({ name: "Demo Holdings Inc.", tin: "000-123-456-00000", ownerUserId: owner.id });
  const sub = await provisionOrganization({ name: "Demo Trading Corp.", tin: "000-654-321-00000", ownerUserId: owner.id });
  await prisma.organization.update({ where: { id: parent.id }, data: { code: "DEMOHOLD" } });
  await prisma.organization.update({ where: { id: sub.id }, data: { code: "DEMOTRD", parentId: parent.id, entityType: "SUBSIDIARY" } });
  for (const o of [parent.id, sub.id]) {
    await prisma.membership.createMany({ data: [
      { userId: acc.id, organizationId: o, role: "ACCOUNTANT", approvalLimit: "500000" },
      { userId: bk.id, organizationId: o, role: "BOOKKEEPER" },
    ] });
  }
  const P = parent.id;
  await importMasters("dimensions", P, owner.id, [
    { type: "DEPARTMENT", code: "ADMIN", name: "Administration" }, { type: "DEPARTMENT", code: "SALES", name: "Sales and Marketing" },
    { type: "DEPARTMENT", code: "OPS", name: "Operations" }, { type: "BRANCH", code: "MNL", name: "Manila" }, { type: "BRANCH", code: "CEB", name: "Cebu" },
    { type: "PROJECT", code: "PRJ-001", name: "SM Fit-out Project" }, { type: "COST_CENTER", code: "CC100", name: "Head Office" },
  ]);
  await importMasters("currencies", P, owner.id, [{ code: "USD", name: "US Dollar", symbol: "$", rateToBase: "58.25" }]);
  await importMasters("accounts", P, owner.id, [{ code: "1027", name: "Cash in Bank - USD Savings", type: "ASSET", ifrsGroup: "Cash and cash equivalents", isCurrent: true, parentCode: "1000", currencyCode: "USD" }]);
  const id = async (code: string, org = P) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
  const dim = async (code: string) => (await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: P, code } })).id;
  const y = new Date().getUTCFullYear();
  const dt = (s: string) => new Date(`${y}-${s}`);

  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-02"), memo: "Opening capital contribution", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await id("1020"), debit: "2000000" }, { accountId: await id("3010"), credit: "2000000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-10"), memo: "Consulting billing to XYZ Trading (SI 0001)", reference: "SI 0001", source: "SALES", action: "post",
    lines: [{ accountId: await id("1100"), debit: "336000", partyType: "CUSTOMER", partyId: "C-0001" }, { accountId: await id("4020"), credit: "300000", dims: { departmentId: await dim("SALES"), projectId: await dim("PRJ-001") } }, { accountId: await id("2030"), credit: "36000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-31"), memo: "Collection from XYZ Trading net of 2% CWT (OR 0001)", reference: "OR 0001", source: "SALES", action: "post",
    lines: [{ accountId: await id("1020"), debit: "330000" }, { accountId: await id("1320"), debit: "6000" }, { accountId: await id("1100"), credit: "336000" }] });
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("02-05"), memo: "Export consulting received in USD", source: "SALES", action: "post",
    lines: [{ accountId: await id("1027"), debit: "5000", currencyCode: "USD", fxRate: "57.80" }, { accountId: await id("4020"), credit: "5000", currencyCode: "USD", fxRate: "57.80", dims: { departmentId: await dim("SALES") } }] });
  // Manual entries through the approval workflow: bookkeeper prepares, accountant approves.
  const manual = [
    { date: "01-15", memo: "Office rent for January, less 5% EWT", ref: "CV 0001", lines: [
      { accountId: await id("6030"), debit: "60000", dims: { departmentId: await dim("ADMIN"), costCenterId: await dim("CC100") } }, { accountId: await id("1310"), debit: "7200" },
      { accountId: await id("2045"), credit: "3000" }, { accountId: await id("1020"), credit: "64200" }] },
    { date: "01-31", memo: "January salaries", ref: "PR-01", lines: [
      { accountId: await id("6010"), debit: "120000", dims: { departmentId: await dim("OPS") } }, { accountId: await id("6010"), debit: "80000", dims: { departmentId: await dim("SALES") } },
      { accountId: await id("2040"), credit: "18000" }, { accountId: await id("1020"), credit: "182000" }] },
    { date: "02-12", memo: "Grab rides for client visits", ref: "GCASH-0212", lines: [
      { accountId: await id("6050"), debit: "2350", dims: { departmentId: await dim("SALES"), projectId: await dim("PRJ-001") } }, { accountId: await id("1030"), credit: "2350" }] },
  ];
  await recordJournal({ organizationId: P, userId: owner.id, date: dt("01-03"), memo: "Fund GCash corporate wallet", source: "BANK", action: "post",
    lines: [{ accountId: await id("1030"), debit: "20000" }, { accountId: await id("1020"), credit: "20000" }] });
  for (const m of manual) {
    const e = await recordJournal({ organizationId: P, userId: bk.id, date: dt(m.date), memo: m.memo, reference: m.ref, lines: m.lines, action: "submit" });
    await postJournal(P, acc.id, e.id);
  }
  await recordJournal({ organizationId: P, userId: bk.id, date: dt("02-20"), memo: "Office supplies from ABC Supplies", reference: "SI 4471", action: "submit",
    lines: [{ accountId: await id("6060"), debit: "4500", dims: { departmentId: await dim("ADMIN") } }, { accountId: await id("1310"), debit: "540" }, { accountId: await id("1010"), credit: "5040" }],
    attachments: [{ name: "SI 4471 scan", url: "https://example.com/si-4471.pdf" }] });

  await setupIntercompany(owner.id, P, sub.id);
  await recordJournal({ organizationId: sub.id, userId: owner.id, date: dt("01-02"), memo: "Opening capital from parent", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await id("1020", sub.id), debit: "500000" }, { accountId: await id("3010", sub.id), credit: "500000" }] });
  await recordIntercompany({ userId: owner.id, date: dt("02-28"), memo: "Management fee charged to Demo Trading for February", reference: "IC-MF-02",
    from: { organizationId: P, lines: [{ accountId: await id("7040"), credit: "25000" }] },
    to: { organizationId: sub.id, lines: [{ accountId: await id("6070", sub.id), debit: "25000" }] } });

  // ---- Cash and bank ----
  await importMasters("vendors", P, owner.id, [{ code: "V-0001", name: "ABC Office Supplies Inc.", ewtRate: "1", atcCode: "WC158" }]);
  await importMasters("banks", P, owner.id, [
    { code: "BDO-CA", name: "BDO Current Account - Makati", kind: "CURRENT", glAccountCode: "1020", bankName: "BDO Unibank", accountNumber: "0012-3456-7890", nextCheckNo: 1001 },
    { code: "BPI-SA", name: "BPI Savings - Payroll", kind: "SAVINGS", glAccountCode: "1025", bankName: "BPI", accountNumber: "1234-5678-90" },
    { code: "BPI-USD", name: "BPI Dollar Savings", kind: "SAVINGS", glAccountCode: "1027", bankName: "BPI", currencyCode: "USD" },
    { code: "PCF-ADMIN", name: "Petty Cash Fund - Admin", kind: "PETTY_CASH", glAccountCode: "1015", custodian: "Ben Bookkeeper", fundLimit: "10000" },
    { code: "GCASH", name: "GCash Corporate Wallet", kind: "EWALLET", glAccountCode: "1030" },
    { code: "COH", name: "Undeposited Collections", kind: "CASH_ON_HAND", glAccountCode: "1010" },
  ]);
  const bank = async (code: string) => (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: P, code } } })).id;
  const BDO = await bank("BDO-CA"), PCF = await bank("PCF-ADMIN");
  const vouch = async (v: Parameters<typeof saveCashTransaction>[0]) => {
    const t = await saveCashTransaction({ ...v, organizationId: P, userId: bk.id, action: "submit" });
    await approveCash(P, acc.id, t.id);
  };
  await vouch({ organizationId: P, userId: bk.id, type: "DISBURSEMENT", bankAccountId: BDO, date: dt("01-20"), payee: "ABC Office Supplies Inc.", partyType: "VENDOR", partyId: "V-0001", method: "CHECK",
    memo: "Office supplies, SI 1180", reference: "SI 1180", withholdingTaxCodeId: (await prisma.taxCode.findFirstOrThrow({ where: { organizationId: P, code: "WC158" } })).id,
    lines: [{ accountId: await id("6060"), amount: "15151.52", dims: { departmentId: await dim("ADMIN") } }] });
  await vouch({ organizationId: P, userId: bk.id, type: "DISBURSEMENT", bankAccountId: BDO, date: dt("01-28"), payee: "Meralco", method: "CHECK", memo: "Electricity for January",
    lines: [{ accountId: await id("6040"), amount: "8500", dims: { departmentId: await dim("ADMIN") } }] });
  await vouch({ organizationId: P, userId: bk.id, type: "TRANSFER", bankAccountId: BDO, toBankAccountId: PCF, date: dt("01-05"), method: "CHECK", amount: "10000", payee: "Ben Bookkeeper", memo: "Establish admin petty cash fund" });
  await vouch({ organizationId: P, userId: bk.id, type: "DISBURSEMENT", bankAccountId: PCF, date: dt("01-12"), payee: "Grab", memo: "Taxi to BIR RDO 47", lines: [{ accountId: await id("6050"), amount: "350", dims: { departmentId: await dim("ADMIN") } }] });
  await vouch({ organizationId: P, userId: bk.id, type: "DISBURSEMENT", bankAccountId: PCF, date: dt("01-14"), payee: "Lalamove", memo: "Deliver documents to client", lines: [{ accountId: await id("6052"), amount: "280" }] });
  // A January statement, uploaded but not yet matched, so the recommended matches can be tried.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await statementTemplate()) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Statement")!;
  [
    [`${y}-01-02`, "CASH DEPOSIT", "DEP0102", "", "", 2000000, 2000000],
    [`${y}-01-03`, "ONLINE TRANSFER TO GCASH", "IB77120", "", 20000, "", 1980000],
    [`${y}-01-06`, "CHECK ENCASHMENT", "", "001003", 10000, "", 1970000],
    [`${y}-01-16`, "CHECK DEPOSITED BY PAYEE", "CV 0001", "", 64200, "", 1905800],
    [`${y}-01-24`, "CLEARING CHECK", "", "001001", 15000, "", 1890800],
    [`${y}-01-31`, "PAYROLL CREDIT", "PR-01", "", 182000, "", 1708800],
    [`${y}-01-31`, "SERVICE CHARGE", "", "", 150, "", 1708650],
    [`${y}-01-31`, "INTEREST EARNED", "", "", "", 85.5, 1708735.5],
    [`${y}-01-31`, "W/TAX ON INTEREST", "", "", 17.1, "", 1708718.4],
  ].forEach((r, i) => { ws.getRow(i + 2).values = r; });
  await importStatement({ organizationId: P, userId: bk.id, bankAccountId: BDO, buf: (await wb.xlsx.writeBuffer()) as ArrayBuffer, fileName: "BDO-January.xlsx", openingBalance: "0" });
  // ---- Purchasing and payables ----
  await importMasters("vendors", P, owner.id, [
    { code: "V-0002", name: "TechHub Computers Corp.", tin: "201-555-019-00000", address: "Gilmore Ave, Quezon City", paymentTermsDays: 30, ewtRate: "1", atcCode: "WC158" },
    { code: "V-0003", name: "Prime Facilities Services Inc.", tin: "305-118-442-00000", paymentTermsDays: 15, ewtRate: "2", atcCode: "WC160" },
  ]);
  const vend = async (code: string) => (await prisma.vendor.findFirstOrThrow({ where: { organizationId: P, code } })).id;
  const ewt = async (code: string) => (await prisma.taxCode.findFirstOrThrow({ where: { organizationId: P, code } })).id;
  const pr = await savePurchaseRequest({ organizationId: P, userId: bk.id, date: dt("02-02"), neededBy: dt("02-15"), purpose: "Laptops for two new accountants", departmentId: await dim("ADMIN"), action: "submit",
    lines: [{ description: "Laptop 14in, 16GB RAM", quantity: "2", unit: "pc", estUnitCost: "58000", category: "FIXED_ASSET", accountId: await id("1530") }, { description: "Laptop bag", quantity: "2", unit: "pc", estUnitCost: "1200", category: "EXPENSE", accountId: await id("6060") }] });
  await approvePurchaseRequest(P, acc.id, pr.id);
  const rfq = await createRfq(P, bk.id, { requestId: pr.id, date: dt("02-03"), dueDate: dt("02-06") });
  const q1 = await saveQuote(P, bk.id, rfq.id, { vendorId: await vend("V-0002"), quoteRef: "Q-2231", leadTimeDays: 3, vatInclusive: true, prices: [{ lineNo: 1, unitPrice: "56500" }, { lineNo: 2, unitPrice: "1100" }] });
  await saveQuote(P, bk.id, rfq.id, { vendorId: await vend("V-0001"), quoteRef: "ABC-77", leadTimeDays: 10, vatInclusive: true, prices: [{ lineNo: 1, unitPrice: "57900" }, { lineNo: 2, unitPrice: "950" }] });
  const po = await awardRfq(P, bk.id, rfq.id, q1.id);
  await submitPurchaseOrder(P, bk.id, po.id);
  await approvePo(P, acc.id, po.id);
  const pol = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { lineNo: "asc" } });
  await recordGoodsReceipt(P, bk.id, { purchaseOrderId: po.id, date: dt("02-07"), deliveryRef: "DR 50021", lines: pol.map((l) => ({ poLineId: l.id, quantity: l.quantity.toString() })) });
  const wc158 = await ewt("WC158");
  const bill1 = await saveBill({ organizationId: P, userId: bk.id, vendorId: await vend("V-0002"), supplierInvoiceNo: "SI 008812", invoiceDate: dt("02-07"), purchaseOrderId: po.id, vatInclusive: true, action: "submit",
    lines: pol.map((l) => ({ description: l.description, category: l.category, accountId: l.accountId, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), poLineId: l.id })).map((l) => ({ ...l, ewtTaxCodeId: wc158 })) });
  await approveBill(P, acc.id, bill1.id);
  const bill2 = await saveBill({ organizationId: P, userId: bk.id, vendorId: await vend("V-0003"), supplierInvoiceNo: "BS-2026-0142", invoiceDate: dt("01-31"), vatInclusive: true, action: "submit",
    memo: "Janitorial services, January", lines: [{ description: "Janitorial and maintenance services, January", category: "EXPENSE", accountId: await id("6065"), unitPrice: "44800", ewtTaxCodeId: await ewt("WC160"), dims: { departmentId: await dim("ADMIN") } }] });
  await approveBill(P, acc.id, bill2.id);
  await saveBill({ organizationId: P, userId: bk.id, vendorId: await vend("V-0003"), supplierInvoiceNo: "BS-2026-0201", invoiceDate: dt("02-28"), vatInclusive: true, action: "submit",
    memo: "Janitorial services, February", lines: [{ description: "Janitorial and maintenance services, February", category: "EXPENSE", accountId: await id("6065"), unitPrice: "44800", ewtTaxCodeId: await ewt("WC160") }] });
  await savePayment({ organizationId: P, userId: bk.id, vendorId: await vend("V-0003"), bankAccountId: BDO, date: dt("02-14"), method: "CHECK", lines: [{ billId: bill2.id, amount: (await prisma.apBill.findUniqueOrThrow({ where: { id: bill2.id } })).netPayable.toString() }], action: "submit" });
  console.log("Demo created. Sign in as owner@demo.ph / accountant@demo.ph / bookkeeper@demo.ph, password demo12345");
}
main().finally(() => prisma.$disconnect());
