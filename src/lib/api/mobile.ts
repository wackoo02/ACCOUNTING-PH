// JSON API for the petty cash mobile app (iPhone and Android). Mounted at /api/mobile/*.
// Every route except login needs "Authorization: Bearer <token>"; "X-Company-Id" picks the company.
import { prisma } from "../db";
import bcrypt from "bcryptjs";
import { can } from "../permissions";
import { LedgerError } from "../ledger/service";
import { ApiError, issueToken, requireApiCtx, revokeToken } from "./auth";
import {
  approvePurchaseOrder, approveVoucher, createBatch, createFund, createPurchaseOrder, createVoucher, getBatch, getVoucher,
  listBatches, listPurchaseOrders, listVouchers, postBatch, previewVoucher, rejectVoucher, setupData, submitVoucher, updateVoucher,
  type VoucherInput,
} from "../pettycash/service";
import { extractReceipt, saveReceiptImage, suggestAccount } from "../pettycash/extract";

type Handler = (req: Request, params: string[], url: URL) => Promise<Response>;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, ["Send a JSON body"]);
  }
}

const routes: [string, RegExp, Handler][] = [
  ["POST", /^auth\/login$/, async (req) => {
    const b = await body<{ email?: string; password?: string }>(req);
    const user = await prisma.user.findUnique({ where: { email: (b.email ?? "").trim().toLowerCase() } });
    if (!user || !(await bcrypt.compare(b.password ?? "", user.passwordHash))) throw new ApiError(401, ["Wrong email or password"]);
    const ms = await prisma.membership.findMany({ where: { userId: user.id }, include: { organization: true }, orderBy: { createdAt: "asc" } });
    if (!ms.length) throw new ApiError(403, ["Your account is not linked to a company yet"]);
    const { token, expiresAt } = await issueToken(user.id, ms[0].organizationId);
    return json({
      token, expiresAt, user: { id: user.id, name: user.name, email: user.email },
      companies: ms.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
    });
  }],
  ["POST", /^auth\/logout$/, async (req) => { await revokeToken(req); return json({ ok: true }); }],
  ["GET", /^me$/, async (req) => {
    const ctx = await requireApiCtx(req);
    const ms = await prisma.membership.findMany({ where: { userId: ctx.user.id }, include: { organization: true }, orderBy: { createdAt: "asc" } });
    return json({
      user: ctx.user, company: ctx.org, role: ctx.role, approvalLimit: ctx.approvalLimit,
      can: { capture: can(ctx.role, "pettycash.capture"), approve: can(ctx.role, "pettycash.approve"), replenish: can(ctx.role, "pettycash.replenish"), postJournal: can(ctx.role, "journal.post"), manage: can(ctx.role, "masters.manage") },
      companies: ms.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
    });
  }],
  ["GET", /^setup$/, async (req) => json(await setupData((await requireApiCtx(req, "pettycash.capture")).org.id))],

  // Funds (admins)
  ["POST", /^funds$/, async (req) => {
    const ctx = await requireApiCtx(req, "masters.manage");
    return json(await createFund(ctx.org.id, ctx.user.id, await body(req)), 201);
  }],

  // Receipts: upload a photo, then let the AI read it.
  ["POST", /^receipts$/, async (req) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    const b = await body<{ imageBase64: string; mediaType: string; extract?: boolean }>(req);
    const img = await saveReceiptImage(ctx.org.id, ctx.user.id, b.imageBase64, b.mediaType);
    if (b.extract === false) return json({ imageId: img.id }, 201);
    try {
      return json(await extractReceipt(ctx.org.id, img.id), 201);
    } catch (e) {
      if (e instanceof LedgerError) return json({ imageId: img.id, extractionError: e.errors[0] }, 201);
      console.error(e);
      return json({ imageId: img.id, extractionError: "The photo could not be read right now. Enter the details by hand or try again." }, 201);
    }
  }],
  ["POST", /^receipts\/([^/]+)\/extract$/, async (req, [id]) => json(await extractReceipt((await requireApiCtx(req, "pettycash.capture")).org.id, id))],
  ["GET", /^receipts\/([^/]+)\/image$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req);
    const img = await prisma.receiptImage.findFirst({ where: { id, organizationId: ctx.org.id } });
    if (!img) throw new ApiError(404, ["Receipt photo not found"]);
    return new Response(new Uint8Array(img.data), { headers: { "content-type": img.mediaType, "cache-control": "private, max-age=86400" } });
  }],
  ["POST", /^suggest-account$/, async (req) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    return json({ account: await suggestAccount(ctx.org.id, (await body<{ description: string }>(req)).description) });
  }],

  // Vouchers
  ["POST", /^vouchers\/preview$/, async (req) => json(await previewVoucher((await requireApiCtx(req, "pettycash.capture")).org.id, await body<VoucherInput>(req)))],
  ["GET", /^vouchers$/, async (req, _, url) => {
    const ctx = await requireApiCtx(req);
    return json(await listVouchers(ctx.org.id, { status: url.searchParams.get("status"), fundId: url.searchParams.get("fundId"), mine: url.searchParams.get("mine"), userId: ctx.user.id }));
  }],
  ["POST", /^vouchers$/, async (req, _, url) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    return json(await createVoucher(ctx.org.id, ctx.user.id, await body<VoucherInput>(req), url.searchParams.get("submit") === "1"), 201);
  }],
  ["GET", /^vouchers\/([^/]+)$/, async (req, [id]) => json(await getVoucher((await requireApiCtx(req)).org.id, id))],
  ["PUT", /^vouchers\/([^/]+)$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    return json(await updateVoucher(ctx.org.id, ctx.user.id, id, await body<VoucherInput>(req)));
  }],
  ["POST", /^vouchers\/([^/]+)\/submit$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    return json(await submitVoucher(ctx.org.id, ctx.user.id, id));
  }],
  ["POST", /^vouchers\/([^/]+)\/approve$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "pettycash.approve");
    return json(await approveVoucher(ctx.org.id, ctx.user.id, id));
  }],
  ["POST", /^vouchers\/([^/]+)\/reject$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "pettycash.approve");
    return json(await rejectVoucher(ctx.org.id, ctx.user.id, id, (await body<{ reason: string }>(req)).reason));
  }],

  // Purchase orders
  ["GET", /^purchase-orders$/, async (req, _, url) => json(await listPurchaseOrders((await requireApiCtx(req)).org.id, url.searchParams.get("status")))],
  ["POST", /^purchase-orders$/, async (req) => {
    const ctx = await requireApiCtx(req, "pettycash.capture");
    return json(await createPurchaseOrder(ctx.org.id, ctx.user.id, await body(req)), 201);
  }],
  ["POST", /^purchase-orders\/([^/]+)\/approve$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "pettycash.approve");
    return json(await approvePurchaseOrder(ctx.org.id, ctx.user.id, id));
  }],

  // Replenishment batches
  ["GET", /^batches$/, async (req, _, url) => json(await listBatches((await requireApiCtx(req)).org.id, url.searchParams.get("fundId")))],
  ["POST", /^batches$/, async (req, _, url) => {
    const ctx = await requireApiCtx(req, "pettycash.replenish");
    return json(await createBatch(ctx.org.id, ctx.user.id, await body(req), url.origin), 201);
  }],
  ["GET", /^batches\/([^/]+)$/, async (req, [id]) => json(await getBatch((await requireApiCtx(req)).org.id, id))],
  ["POST", /^batches\/([^/]+)\/post$/, async (req, [id]) => {
    const ctx = await requireApiCtx(req, "journal.post");
    return json(await postBatch(ctx.org.id, ctx.user.id, id));
  }],
];

export async function handleMobile(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  try {
    let methodMismatch = false;
    for (const [method, re, h] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      if (method !== req.method) { methodMismatch = true; continue; }
      return await h(req, m.slice(1).map(decodeURIComponent), url);
    }
    return json({ errors: [methodMismatch ? "Method not allowed" : "Not found"] }, methodMismatch ? 405 : 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ errors: e.errors }, e.status);
    if (e instanceof LedgerError) return json({ errors: e.errors }, 422);
    console.error(e);
    return json({ errors: ["Something went wrong. Please try again."] }, 500);
  }
}
