// End-to-end through the mobile API router against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { issueToken } from "@/lib/api/auth";
import { handleMobile } from "@/lib/api/mobile";

let orgId = "", otherOrg = "", owner = "", clerk = "", accountant = "";
let ownerTok = "", clerkTok = "", acctTok = "";
const email = `clerk${Date.now()}@test.local`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`https://veritus.test/api/mobile/${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleMobile(req, path.split("?")[0]);
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.arrayBuffer() };
}

beforeAll(async () => {
  const mk = (n: string, e = `${n}${Date.now()}${Math.random()}@test.local`, pw = "x") => prisma.user.create({ data: { email: e, name: n, passwordHash: pw } });
  owner = (await mk("owner")).id;
  clerk = (await mk("clerk", email, await bcrypt.hash("secret123", 4))).id;
  accountant = (await mk("accountant")).id;
  orgId = (await provisionOrganization({ name: "PCF Co", ownerUserId: owner })).id;
  otherOrg = (await provisionOrganization({ name: "Other Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: orgId, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: orgId, role: "ACCOUNTANT", approvalLimit: "100000" },
  ] });
  ownerTok = (await issueToken(owner, orgId)).token;
  acctTok = (await issueToken(accountant, orgId)).token;
});

afterAll(async () => {
  const ids = { in: [orgId, otherOrg] };
  await prisma.pettyCashVoucherLine.deleteMany({ where: { voucher: { organizationId: ids } } });
  await prisma.pettyCashVoucher.deleteMany({ where: { organizationId: ids } });
  await prisma.pettyCashBatch.deleteMany({ where: { organizationId: ids } });
  await prisma.pettyCashFund.deleteMany({ where: { organizationId: ids } });
  await prisma.purchaseOrder.deleteMany({ where: { organizationId: ids } });
  await prisma.receiptImage.deleteMany({ where: { organizationId: ids } });
  await prisma.journalLine.deleteMany({ where: { organizationId: ids } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ids } });
  await prisma.account.updateMany({ where: { organizationId: ids }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: ids } });
  await prisma.organization.deleteMany({ where: { id: ids } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
  await prisma.$disconnect();
});

describe("petty cash mobile API", () => {
  let fundId = "", meals = "", equip = "", wc158 = "", imageId = "", poNumber = "", poId = "";
  const vouchers: string[] = [];

  it("signs in with email and password and rejects bad tokens and other companies", async () => {
    expect((await call("POST", "auth/login", undefined, { email, password: "wrong" })).status).toBe(401);
    const r = await call("POST", "auth/login", undefined, { email: email.toUpperCase(), password: "secret123" });
    expect(r.status).toBe(200);
    clerkTok = r.data.token;
    expect(r.data.companies).toHaveLength(1);
    expect((await call("GET", "me", "nope")).status).toBe(401);
    expect((await call("GET", "me", clerkTok, undefined, { "x-company-id": otherOrg })).status).toBe(403);
    const me = await call("GET", "me", clerkTok);
    expect(me.data.can).toMatchObject({ capture: true, approve: false, replenish: true });
  });

  it("lets an admin set up a fund and returns setup data with the PHP 5,000 threshold", async () => {
    expect((await call("POST", "funds", clerkTok, { code: "PCF1", name: "x" })).status).toBe(403);
    const f = await call("POST", "funds", ownerTok, { code: "pcf1", name: "Head Office Petty Cash", imprestAmount: "10000", custodianUserId: clerk });
    expect(f.status).toBe(201);
    fundId = f.data.id;
    const s = await call("GET", "setup", clerkTok);
    expect(s.data.fixedAssetThreshold).toBe("5000");
    meals = s.data.accounts.find((a: { code: string }) => a.code === "6120").id;
    equip = s.data.accounts.find((a: { code: string }) => a.code === "1530").id;
    wc158 = s.data.taxCodes.find((t: { code: string }) => t.code === "WC158").id;
    expect(s.data.funds[0].code).toBe("PCF1");
  });

  it("stores a receipt photo and serves it back", async () => {
    const r = await call("POST", "receipts", clerkTok, { imageBase64: PNG, mediaType: "image/png", extract: false });
    expect(r.status).toBe(201);
    imageId = r.data.imageId;
    const img = await call("GET", `receipts/${imageId}/image`, clerkTok);
    expect(img.status).toBe(200);
    expect((await call("POST", "receipts", clerkTok, { imageBase64: PNG, mediaType: "application/pdf" })).status).toBe(422);
  });

  it("previews and submits a meal receipt with a handwritten tip", async () => {
    const body = {
      fundId, receiptDate: "2026-11-10", docType: "OR", docNumber: "004512", vendorName: "Kusina ni Juan Inc.", vendorTin: "123-456-789-00000",
      vendorAddress: "Makati City", vendorVatRegistered: true, tipAmount: "50", tipHandwritten: true, imageId,
      lines: [{ description: "Team lunch", quantity: "4", unitPrice: "280", accountId: meals, suggestedAccountId: meals }],
    };
    const p = await call("POST", "vouchers/preview", clerkTok, body);
    expect(p.data).toMatchObject({ ok: true, gross: "1120.00", vat: "120.00", tip: "50.00", totalPaid: "1170.00" });
    const v = await call("POST", "vouchers?submit=1", clerkTok, body);
    expect(v.status).toBe(201);
    expect(v.data).toMatchObject({ status: "SUBMITTED", number: "PCV-2026-000001", totalPaid: "1170.00" });
    vouchers.push(v.data.id);
  });

  it("blocks a fixed asset without an approved PO, then accepts it with one", async () => {
    const body = {
      fundId, receiptDate: "2026-11-11", docType: "SI", docNumber: "SI-889", vendorName: "Octagon Computer", vendorTin: "222-333-444-000",
      ewtTaxCodeId: wc158, lines: [{ description: "Printer", unitPrice: "11200", isFixedAsset: true, accountId: equip }],
    };
    const bad = await call("POST", "vouchers?submit=1", clerkTok, body);
    expect(bad.status).toBe(422);
    expect(bad.data.errors.join()).toMatch(/approved PO/);

    const po = await call("POST", "purchase-orders", clerkTok, { description: "Office printer", amount: "12000" });
    expect(po.status).toBe(201);
    poNumber = po.data.number; poId = po.data.id;
    expect((await call("POST", `vouchers?submit=1`, clerkTok, { ...body, poNumber })).data.errors.join()).toMatch(/not approved/);
    expect((await call("POST", `purchase-orders/${poId}/approve`, clerkTok)).status).toBe(403);
    expect((await call("POST", `purchase-orders/${poId}/approve`, ownerTok)).data.status).toBe("APPROVED");

    const ok = await call("POST", "vouchers?submit=1", clerkTok, { ...body, poNumber });
    expect(ok.status).toBe(201);
    // 11,200 VAT-inclusive: VAT 1,200; EWT 1% of 10,000 = 100; cash paid 11,100.
    expect(ok.data).toMatchObject({ vatAmount: "1200.00", ewtAmount: "100.00", totalPaid: "11100.00", poNumber });
    vouchers.push(ok.data.id);
  });

  it("approves only by admins, within limits, and not by the preparer", async () => {
    expect((await call("POST", `vouchers/${vouchers[0]}/approve`, clerkTok)).status).toBe(403);
    expect((await call("POST", `vouchers/${vouchers[0]}/approve`, acctTok)).status).toBe(403);
    for (const id of vouchers) expect((await call("POST", `vouchers/${id}/approve`, ownerTok)).data.status).toBe("APPROVED");
    const list = await call("GET", "vouchers?status=APPROVED", clerkTok);
    expect(list.data).toHaveLength(2);
  });

  it("returns a voucher with a reason, and it can be fixed and resubmitted", async () => {
    const v = await call("POST", "vouchers?submit=1", clerkTok, {
      fundId, receiptDate: "2026-11-12", vendorName: "Grab", vendorVatRegistered: false,
      lines: [{ description: "Grab to BIR RDO 47", unitPrice: "245", accountId: meals }],
    });
    expect((await call("POST", `vouchers/${v.data.id}/reject`, ownerTok, { reason: "" })).status).toBe(422);
    const r = await call("POST", `vouchers/${v.data.id}/reject`, ownerTok, { reason: "Charge to transportation" });
    expect(r.data).toMatchObject({ status: "REJECTED", rejectedReason: "Charge to transportation" });
  });

  it("builds a replenishment batch with a balanced journal and posts it to the GL", async () => {
    const b = await call("POST", "batches", clerkTok, { fundId, date: "2026-11-15" });
    expect(b.status).toBe(201);
    expect(b.data.status).toBe("PENDING_APPROVAL");
    expect(b.data.totals).toMatchObject({ vouchers: 2, vat: "1320.00", ewt: "100.00", tip: "50.00", totalPaid: "12270.00" });
    const j = b.data.journal;
    expect(j.number).toMatch(/^PC-2026-/);
    expect(j.totalDebit).toBe(j.totalCredit);
    const by = (code: string, side: "debit" | "credit") => j.lines.filter((l: { accountCode: string }) => l.accountCode === code).reduce((s: number, l: Record<string, string>) => s + Number(l[side]), 0);
    expect(by("1530", "debit")).toBe(10000);
    expect(by("6120", "debit")).toBe(1050); // 1,000 net of VAT + 50 tip
    expect(by("1310", "debit")).toBe(1320);
    expect(by("2045", "credit")).toBe(100);
    expect(by("1015", "credit")).toBe(12270);
    expect((await call("GET", `vouchers/${vouchers[0]}`, clerkTok)).data.status).toBe("BATCHED");

    expect((await call("POST", "batches", clerkTok, { fundId })).status).toBe(422); // nothing left to batch
    expect((await call("POST", `batches/${b.data.id}/post`, clerkTok)).status).toBe(403);
    const posted = await call("POST", `batches/${b.data.id}/post`, acctTok);
    expect(posted.status).toBe(200);
    expect(posted.data.status).toBe("REPLENISHED");
    expect((await call("GET", `vouchers/${vouchers[1]}`, clerkTok)).data.status).toBe("REPLENISHED");
    const att = await prisma.journalAttachment.findMany({ where: { journalEntryId: j.id } });
    expect(att[0].url).toBe(`https://veritus.test/api/receipts/${imageId}`);
  });

  it("logs out", async () => {
    await call("POST", "auth/logout", clerkTok);
    expect((await call("GET", "me", clerkTok)).status).toBe(401);
  });
});
