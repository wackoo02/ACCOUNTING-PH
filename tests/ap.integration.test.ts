// Purchasing and accounts payable end to end, against the database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { importMasters } from "@/lib/masters/store";
import { recordJournal } from "@/lib/ledger/service";
import { saveApprovalRule, canApproveNow } from "@/lib/approvals";
import {
  approvePo, approvePurchaseRequest, awardRfq, createRfq, recordGoodsReceipt, saveQuote, savePurchaseRequest, submitPurchaseOrder, voidGoodsReceipt,
} from "@/lib/purchasing/service";
import { approveBill, saveBill, voidBill } from "@/lib/ap/bills";
import { approvePayment, certificatesForPayment, createPaymentRun, savePayment, voidPayment } from "@/lib/ap/payments";
import { apAging } from "@/lib/ap/aging";
import { addInboxDocument, ensureInboxAlias, matchExtraction, organizationForRecipients, parseInboundEmail, saveInboxSettings, senderAllowed } from "@/lib/ap/inbox";
import { receiveInboundEmail } from "@/lib/ap/inbound";
import { voidCash } from "@/lib/bank/cash";

let org = "", owner = "", clerk = "", accountant = "", head = "";
let vendorA = "", vendorB = "", bdo = "";
const d = (s: string) => new Date(`2026-${s}`);
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const tax = async (code: string) => (await prisma.taxCode.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const balance = async (code: string) => {
  const a = await prisma.journalLine.aggregate({ where: { organizationId: org, account: { code }, journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true } });
  return Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0);
};

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id; head = (await mk("head")).id;
  org = (await provisionOrganization({ name: "AP Test Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: org, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: org, role: "ACCOUNTANT" },
    { userId: head, organizationId: org, role: "VIEWER" },
  ] });
  await importMasters("vendors", org, owner, [
    { code: "V-1", name: "ABC Office Supplies Inc.", tin: "123-456-789-00000", paymentTermsDays: 30, vatRegistered: true, ewtRate: 1, atcCode: "WC158" },
    { code: "V-2", name: "XYZ Trading Corp.", tin: "987-654-321-00000", paymentTermsDays: 15, vatRegistered: true },
  ]);
  vendorA = (await prisma.vendor.findFirstOrThrow({ where: { organizationId: org, code: "V-1" } })).id;
  vendorB = (await prisma.vendor.findFirstOrThrow({ where: { organizationId: org, code: "V-2" } })).id;
  await importMasters("banks", org, owner, [{ code: "BDO", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020", nextCheckNo: 5001 }]);
  bdo = (await prisma.bankAccount.findFirstOrThrow({ where: { organizationId: org, code: "BDO" } })).id;
  await recordJournal({ organizationId: org, userId: owner, date: d("01-01"), memo: "Opening", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await acct("1020"), debit: "1000000" }, { accountId: await acct("3010"), credit: "1000000" }] });
});

afterAll(async () => {
  for (const t of ["apPaymentLine", "apPayment", "apBillLine", "apBill", "apInboxDocument", "goodsReceiptLine", "goodsReceipt", "purchaseOrderLine", "rfqQuote", "rfq", "purchaseRequestLine", "approvalStep", "approvalRule"] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (prisma as any)[t];
    await m.deleteMany(t.endsWith("Line") || t === "rfqQuote" ? {} : { where: { organizationId: org } }).catch(() => undefined);
  }
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.cashTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.bankMatch.deleteMany({ where: { organizationId: org } });
  await prisma.purchaseOrder.deleteMany({ where: { organizationId: org } });
  await prisma.purchaseRequest.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant, head] } } });
});

describe("procure to pay", () => {
  let poId = "", poLine1 = "", poLine2 = "", billId = "";

  it("purchase request, two-level approval, canvass and award", async () => {
    // PR: one level by a named department head (a viewer), then the accountant above 50k.
    await saveApprovalRule(org, { docType: "PR", level: 1, name: "Department head", minAmount: "0", approverUserId: head });
    await saveApprovalRule(org, { docType: "PR", level: 2, name: "Finance", minAmount: "50000", approverRole: "ACCOUNTANT" });
    const pr = await savePurchaseRequest({ organizationId: org, userId: clerk, date: d("03-01"), purpose: "Laptops and paper for accounting", action: "submit", lines: [
      { description: "Laptop 14in", quantity: "2", estUnitCost: "56000", category: "FIXED_ASSET", accountId: await acct("1530") },
      { description: "Bond paper A4 (ream)", quantity: "10", estUnitCost: "250", category: "EXPENSE", accountId: await acct("6060") },
    ] });
    await expect(approvePurchaseRequest(org, accountant, pr.id)).rejects.toThrow(/Department head/);
    expect(await approvePurchaseRequest(org, head, pr.id)).toBe(false);
    await expect(approvePurchaseRequest(org, head, pr.id)).rejects.toThrow(/already approved/);
    expect(await approvePurchaseRequest(org, accountant, pr.id)).toBe(true);

    const rfq = await createRfq(org, clerk, { requestId: pr.id, date: d("03-02") });
    await saveQuote(org, clerk, rfq.id, { vendorId: vendorA, vatInclusive: true, prices: [{ lineNo: 1, unitPrice: "56000" }, { lineNo: 2, unitPrice: "240" }] });
    const qb = await saveQuote(org, clerk, rfq.id, { vendorId: vendorB, vatInclusive: true, prices: [{ lineNo: 1, unitPrice: "55000" }, { lineNo: 2, unitPrice: "260" }] });
    const qa = await prisma.rfqQuote.findFirstOrThrow({ where: { rfqId: rfq.id, vendorId: vendorA } });
    expect(Number(qb.total)).toBeLessThan(Number(qa.total));
    await expect(awardRfq(org, clerk, rfq.id, qa.id)).rejects.toThrow(/not the lowest/);
    const po = await awardRfq(org, clerk, rfq.id, qa.id, "Faster delivery and 3-year warranty");
    poId = po.id;
    expect(po.status).toBe("DRAFT");
    expect(Number(po.amount)).toBe(56000 * 2 + 240 * 10);
    expect((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("ORDERED");
  });

  it("PO approval with default rule, receiving posts to GRNI", async () => {
    await submitPurchaseOrder(org, clerk, poId);
    await expect(approvePo(org, clerk, poId)).rejects.toThrow();
    const chk = await canApproveNow(org, "PO", poId, accountant, 11440000n, [clerk]);
    expect(chk.ok).toBe(true);
    expect(await approvePo(org, accountant, poId)).toBe(true);
    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId }, orderBy: { lineNo: "asc" } });
    poLine1 = lines[0].id; poLine2 = lines[1].id;
    await expect(recordGoodsReceipt(org, clerk, { purchaseOrderId: poId, date: d("03-05"), lines: [{ poLineId: poLine1, quantity: "3" }] })).rejects.toThrow(/exceed/);
    await recordGoodsReceipt(org, clerk, { purchaseOrderId: poId, date: d("03-05"), deliveryRef: "DR-881", lines: [{ poLineId: poLine1, quantity: "2" }, { poLineId: poLine2, quantity: "10" }] });
    // 2 x 50,000 + 10 x 214.29 (240/1.12) net of VAT
    expect(await balance("1530")).toBe(100000);
    expect(await balance("2012")).toBeCloseTo(-(100000 + 2142.86), 2);
  });

  it("bill matched to the PO: 3-way match, VAT, EWT, approval, GL", async () => {
    const base = { organizationId: org, userId: clerk, vendorId: vendorA, supplierInvoiceNo: "SI-0045", invoiceDate: d("03-06"), purchaseOrderId: poId, vatInclusive: true };
    const lines = [
      { description: "Laptop 14in", category: "FIXED_ASSET", accountId: await acct("1530"), quantity: "3", unitPrice: "56000", poLineId: poLine1, ewtTaxCodeId: await tax("WC158") },
    ];
    await expect(saveBill({ ...base, lines })).rejects.toThrow(/more than received/);
    lines[0].quantity = "2";
    const paperAcct = (await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine2 } })).accountId;
    const b = await saveBill({ ...base, action: "submit", lines: [...lines, { description: "Bond paper", category: "EXPENSE", accountId: paperAcct, quantity: "10", unitPrice: "250", poLineId: poLine2, ewtTaxCodeId: await tax("WC158") }] });
    billId = b.id;
    expect((b.matchNotes as string[]).some((m) => m.includes("price differs"))).toBe(true);
    // Duplicate invoice number from the same supplier is refused.
    await expect(saveBill({ ...base, supplierInvoiceNo: "si 45", purchaseOrderId: null, lines: [{ description: "x", category: "EXPENSE", accountId: paperAcct, unitPrice: "10" }] })).rejects.toThrow(/already recorded/);
    // Fixed asset without a PO is refused.
    await expect(saveBill({ ...base, supplierInvoiceNo: "SI-9", purchaseOrderId: null, lines: [{ description: "Printer", category: "FIXED_ASSET", accountId: await acct("1530"), unitPrice: "20000" }] })).rejects.toThrow(/approved PO/);
    expect(await approveBill(org, accountant, billId)).not.toBeNull();
    const bill = await prisma.apBill.findUniqueOrThrow({ where: { id: billId } });
    // total = 112,000 + 2,500 ; net = 100,000 + 2,232.14 ; EWT 1% = 1,022.32
    expect(Number(bill.total)).toBe(114500);
    expect(Number(bill.ewtAmount)).toBeCloseTo(1022.32, 2);
    expect(await balance("2012")).toBeCloseTo(0, 2);
    expect(await balance("2010")).toBeCloseTo(-(114500 - 1022.32), 2);
    expect(await balance("2045")).toBeCloseTo(-1022.32, 2);
    // A received item already billed cannot be un-received.
    const rr = await prisma.goodsReceipt.findFirstOrThrow({ where: { purchaseOrderId: poId } });
    await expect(voidGoodsReceipt(org, clerk, rr.id, "wrong")).rejects.toThrow(/already billed/);
  });

  it("aging, payment run, check, 2307, and void", async () => {
    const aging = await apAging(org, d("05-01"));
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].bucket).toBe("D1_30");
    expect(aging.gl).toBe(aging.subledger);

    const [pv] = await createPaymentRun(org, clerk, { bankAccountId: bdo, date: d("04-10"), method: "CHECK", billIds: [billId], submit: true });
    await expect(savePayment({ organizationId: org, userId: clerk, vendorId: vendorA, bankAccountId: bdo, date: d("04-10"), method: "CHECK", lines: [{ billId, amount: "1" }] })).rejects.toThrow(/unpaid balance/);
    const cash = await approvePayment(org, accountant, pv.id);
    expect(cash?.checkNo).toBe("005001");
    expect(await balance("2010")).toBeCloseTo(0, 2);
    await expect(voidCash(org, accountant, cash!.id, "x")).rejects.toThrow(/Void the payment voucher/);

    const { certs } = await certificatesForPayment(org, pv.id);
    expect(certs).toHaveLength(1);
    expect(certs[0].quarter).toBe(1);
    expect(certs[0].rows[0].atc).toBe("WC158");
    expect(Number(certs[0].totalTax) / 100).toBeCloseTo(1022.32, 2);
    expect(certs[0].rows[0].months[2]).toBe(certs[0].totalIncome); // March = 3rd month of Q1

    expect((await apAging(org, d("05-01"))).rows).toHaveLength(0);
    await expect(voidBill(org, accountant, billId, "x")).rejects.toThrow(/Payment/);
    await voidPayment(org, accountant, pv.id, "Spoiled check");
    expect(await balance("2010")).toBeCloseTo(-(114500 - 1022.32), 2);
    expect((await apAging(org, d("05-01"))).rows).toHaveLength(1);
  });

  it("inbox: email parsing, duplicate files, supplier and PO matching", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(20000, 1)]);
    const mail = parseInboundEmail({ From: "billing@abc.ph", Subject: "Invoice SI-0046", Attachments: [
      { Name: "SI-0046.pdf", Content: pdf.toString("base64"), ContentType: "application/pdf" },
      { Name: "logo.png", Content: Buffer.alloc(800).toString("base64"), ContentType: "image/png" },
    ] });
    expect(mail.files).toHaveLength(2);
    const docs = [];
    for (const f of mail.files) docs.push(await addInboxDocument(org, { source: "EMAIL", fileName: f.name, mediaType: f.type, data: f.data, fromEmail: mail.from, subject: mail.subject }));
    expect(docs[0]).not.toBeNull();
    expect(docs[1]).toBeNull(); // small image = email signature
    const again = await addInboxDocument(org, { source: "UPLOAD", fileName: "copy.pdf", data: pdf });
    expect(again?.duplicateOfId).toBe(docs[0]!.id);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const m = await matchExtraction(org, {
      isInvoice: true, docType: "SALES_INVOICE", invoiceNo: "SI-0045", invoiceDate: "2026-03-06", dueDate: "", paymentTerms: "", poNumber: po.number, currency: "PHP",
      vendor: { name: "ABC OFFICE SUPPLIES, INC", tin: "123456789000", address: "", vatRegistered: true, email: "" }, pricesIncludeVat: true, lines: [],
      vatableSales: "0", vatAmount: "0", vatExemptSales: "0", zeroRatedSales: "0", totalAmountDue: "0", withholdingTaxShown: "0", ewtAtcSuggestion: "", notes: "", confidence: "high",
    });
    expect(m.vendorId).toBe(vendorA);
    expect(m.purchaseOrderId).toBe(poId);
    expect(m.duplicateBill?.id).toBe(billId);
  });

  it("inbox: each company has its own address, set by its admin, and email is routed by recipient", async () => {
    process.env.AP_INBOX_DOMAIN = "inbox.veritus.test";
    const alias = await ensureInboxAlias(org);
    expect(alias).toMatch(/-ap-[0-9a-f]{4}$/);
    expect(await ensureInboxAlias(org)).toBe(alias); // stable once made
    await expect(saveInboxSettings(org, owner, { alias: "x", address: "", senders: "", enabled: true })).rejects.toThrow(/4 to 40/);
    await expect(saveInboxSettings(org, owner, { alias: "postmaster", address: "", senders: "", enabled: true })).rejects.toThrow(/reserved/);
    await expect(saveInboxSettings(org, owner, { alias: "acme-ap", address: "", senders: "not an email", enabled: true })).rejects.toThrow(/Not an email/);
    await saveInboxSettings(org, owner, { alias: "Acme-AP", address: "AP@acme.ph", senders: "@abc.ph, billing@techhub.ph", enabled: true });
    const o = await prisma.organization.findUniqueOrThrow({ where: { id: org } });
    expect([o.apInboxAlias, o.apInboxAddress]).toEqual(["acme-ap", "ap@acme.ph"]);
    // Forwarded from the company's own mailbox: Postmark reports the Veritus address as OriginalRecipient.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(21000, 7)]);
    const mail = parseInboundEmail({ From: "Sales <sales@abc.ph>", FromFull: { Email: "sales@abc.ph" }, To: "ap@acme.ph", OriginalRecipient: "acme-ap@inbox.veritus.test", Attachments: [{ Name: "inv.pdf", Content: pdf.toString("base64"), ContentType: "application/pdf" }] });
    expect(mail.to).toEqual(expect.arrayContaining(["acme-ap@inbox.veritus.test", "ap@acme.ph"]));
    expect((await organizationForRecipients(mail.to))?.id).toBe(org);
    expect((await organizationForRecipients(["ap@acme.ph"]))?.id).toBe(org); // own address registered
    expect(await organizationForRecipients(["someone-else@inbox.veritus.test"])).toBeNull();
    expect((await receiveInboundEmail(o, mail)).ids).toHaveLength(1);
    expect(senderAllowed(o.apInboxSenders, "x@mail.abc.ph")).toBe(true);
    expect(senderAllowed(o.apInboxSenders, "spam@other.ph")).toBe(false);
    expect((await receiveInboundEmail(o, { ...mail, from: "spam@other.ph" })).ids).toHaveLength(0);
    await saveInboxSettings(org, owner, { alias: "acme-ap", address: "", senders: "", enabled: false });
    const off = await prisma.organization.findUniqueOrThrow({ where: { id: org } });
    expect((await receiveInboundEmail(off, mail)).ids).toHaveLength(0);
  });
});
