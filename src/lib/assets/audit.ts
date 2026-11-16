// Asset audit: scan QR stickers with the Veritus Mobility app, sync what was seen to the
// fixed asset register (tagged / last seen / location / condition) and summarize the count.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, audit, nextNumber } from "../ledger/service";

type Tx = Prisma.TransactionClient;
export const CONDITIONS = ["GOOD", "FAIR", "DAMAGED", "FOR_REPAIR"] as const;

/** What goes in the QR code: a short prefix and the asset number. */
export const qrPayload = (code: string) => `VFA:${code}`;
/** Accept our own sticker ("VFA:FA-0001"), a link ending in the asset no., or a plain code / old tag. */
export function parseTag(text: string) {
  const t = (text ?? "").trim();
  const m = /^VFA:(.+)$/i.exec(t);
  if (m) return m[1].trim();
  const u = /\/assets?\/([^/?#]+)\/?$/i.exec(t);
  if (u) return decodeURIComponent(u[1]);
  return t;
}
const sameLoc = (a?: string | null, b?: string | null) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

async function findByTag(tx: Tx, organizationId: string, text: string) {
  const code = parseTag(text);
  if (!code) return null;
  return (await tx.fixedAsset.findFirst({ where: { organizationId, code: { equals: code, mode: "insensitive" } } }))
    ?? (await tx.fixedAsset.findFirst({ where: { organizationId, tagCode: { equals: code, mode: "insensitive" } } }));
}

const assetOut = (a: Prisma.FixedAssetGetPayload<object>) => ({
  id: a.id, code: a.code, name: a.name, category: a.category, location: a.location, custodianCode: a.custodianCode, serialNo: a.serialNo,
  acquisitionDate: a.acquisitionDate?.toISOString().slice(0, 10) ?? null, cost: fromCentavos(toCentavos(a.cost.toString())), tagCode: a.tagCode,
  status: a.status, condition: a.condition, taggedAt: a.taggedAt, lastSeenAt: a.lastSeenAt, lastSeenLocation: a.lastSeenLocation, qr: qrPayload(a.code),
});

export async function lookupAsset(organizationId: string, tag: string) {
  const a = await prisma.$transaction((tx) => findByTag(tx, organizationId, tag));
  return a ? assetOut(a) : null;
}

export async function listAssets(organizationId: string, f: { location?: string | null; q?: string | null } = {}) {
  const rows = await prisma.fixedAsset.findMany({
    where: { organizationId, isActive: true, ...(f.location ? { location: { equals: f.location, mode: "insensitive" } } : {}),
      ...(f.q ? { OR: [{ code: { contains: f.q, mode: "insensitive" } }, { name: { contains: f.q, mode: "insensitive" } }] } : {}) },
    orderBy: { code: "asc" }, take: 2000,
  });
  return rows.map(assetOut);
}

export async function startAudit(organizationId: string, userId: string, input: { name?: string | null; location?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const year = new Date().getUTCFullYear();
    const number = await nextNumber(tx, organizationId, "AA", year);
    const a = await tx.assetAudit.create({ data: { organizationId, number, name: input.name?.trim() || `Asset count ${new Date().toISOString().slice(0, 10)}`, location: input.location?.trim() || null, createdById: userId } });
    await audit(tx, organizationId, userId, "asset.audit_start", a.id, { number }, null, null, "asset_audit");
    return a;
  });
}

/** Record one scan and update the register. Scanning the same asset twice in an audit just refreshes it. */
export async function scanAsset(organizationId: string, userId: string, auditId: string, input: { tagText: string; location?: string | null; condition?: string | null; note?: string | null; imageId?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const au = await tx.assetAudit.findFirst({ where: { id: auditId, organizationId } });
    if (!au) throw new LedgerError(["Audit not found"]);
    if (au.status !== "OPEN") throw new LedgerError(["This audit is closed"]);
    if (!input.tagText?.trim()) throw new LedgerError(["Scan the QR code or type the asset number"]);
    const condition = input.condition ? input.condition.toUpperCase() : null;
    if (condition && !(CONDITIONS as readonly string[]).includes(condition)) throw new LedgerError([`Condition must be one of ${CONDITIONS.join(", ")}`]);
    const location = input.location?.trim() || au.location || null;
    const asset = await findByTag(tx, organizationId, input.tagText);
    const result = !asset ? "UNKNOWN" : sameLoc(asset.location, location) ? "FOUND" : "WRONG_LOCATION";
    const prev = asset ? await tx.assetScan.findFirst({ where: { auditId, assetId: asset.id } }) : null;
    const data = { tagText: input.tagText.trim(), result, location, condition, note: input.note?.trim() || null, imageId: input.imageId || null, scannedById: userId, scannedAt: new Date() };
    const scan = prev
      ? await tx.assetScan.update({ where: { id: prev.id }, data })
      : await tx.assetScan.create({ data: { organizationId, auditId, assetId: asset?.id ?? null, ...data } });
    if (asset) {
      await tx.fixedAsset.update({ where: { id: asset.id }, data: {
        lastSeenAt: new Date(), lastSeenLocation: location, lastAuditId: auditId, taggedAt: asset.taggedAt ?? new Date(),
        ...(condition ? { condition } : {}), ...(asset.status === "MISSING" ? { status: "ACTIVE" } : {}), ...(condition === "FOR_REPAIR" ? { status: "FOR_REPAIR" } : {}),
      } });
    }
    return { scan: { id: scan.id, result, location, condition, repeated: !!prev }, asset: asset ? assetOut(await tx.fixedAsset.findUniqueOrThrow({ where: { id: asset.id } })) : null };
  });
}

/** Map a sticker the register did not know (e.g. an old tag) to an asset; its scans in open audits are re-read. */
export async function mapTag(organizationId: string, userId: string, input: { tagText: string; assetId: string }) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.fixedAsset.findFirst({ where: { id: input.assetId, organizationId } });
    if (!a) throw new LedgerError(["Asset not found"]);
    const tag = parseTag(input.tagText);
    if (!tag) throw new LedgerError(["Scan the sticker to map"]);
    const other = await findByTag(tx, organizationId, tag);
    if (other && other.id !== a.id) throw new LedgerError([`That sticker already belongs to ${other.code} ${other.name}`]);
    await tx.fixedAsset.update({ where: { id: a.id }, data: { tagCode: tag === a.code ? a.tagCode : tag, taggedAt: a.taggedAt ?? new Date() } });
    const scans = await tx.assetScan.findMany({ where: { organizationId, assetId: null, audit: { status: "OPEN" } } });
    for (const s of scans.filter((x) => parseTag(x.tagText).toLowerCase() === tag.toLowerCase())) {
      await tx.assetScan.update({ where: { id: s.id }, data: { assetId: a.id, result: sameLoc(a.location, s.location) ? "FOUND" : "WRONG_LOCATION" } });
      await tx.fixedAsset.update({ where: { id: a.id }, data: { lastSeenAt: s.scannedAt, lastSeenLocation: s.location, lastAuditId: s.auditId } });
    }
    await audit(tx, organizationId, userId, "asset.map_tag", a.id, { code: a.code, tag }, null, null, "fixed_asset");
    return assetOut(await tx.fixedAsset.findUniqueOrThrow({ where: { id: a.id } }));
  });
}

/** Close the count. Assets in scope that were not scanned are marked MISSING in the register. */
export async function closeAudit(organizationId: string, userId: string, auditId: string, markMissing = true) {
  const s = await auditSummary(organizationId, auditId);
  if (s.audit.status !== "OPEN") throw new LedgerError(["This audit is already closed"]);
  await prisma.$transaction(async (tx) => {
    if (markMissing && s.missing.length) await tx.fixedAsset.updateMany({ where: { id: { in: s.missing.map((m) => m.id) }, status: { notIn: ["DISPOSED", "RETIRED", "CANCELLED"] } }, data: { status: "MISSING" } });
    await tx.assetAudit.update({ where: { id: auditId }, data: { status: "CLOSED", closedById: userId, closedAt: new Date() } });
    await audit(tx, organizationId, userId, "asset.audit_close", auditId, { found: s.totals.found, missing: s.totals.missing }, null, null, "asset_audit");
  });
  return auditSummary(organizationId, auditId);
}

export async function listAudits(organizationId: string) {
  const rows = await prisma.assetAudit.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50, include: { _count: { select: { scans: true } } } });
  return rows.map((a) => ({ id: a.id, number: a.number, name: a.name, location: a.location, status: a.status, createdAt: a.createdAt, closedAt: a.closedAt, scans: a._count.scans }));
}

type Bucket = { key: string; expected: number; found: number; missing: number; cost: bigint; missingCost: bigint };

/** Found / wrong location / missing / unknown tags, with breakdowns by location, category and condition. */
export async function auditSummary(organizationId: string, auditId: string) {
  const au = await prisma.assetAudit.findFirst({ where: { id: auditId, organizationId }, include: { scans: { orderBy: { scannedAt: "asc" } } } });
  if (!au) throw new LedgerError(["Audit not found"]);
  const scope = await prisma.fixedAsset.findMany({ where: { organizationId, isActive: true, status: { notIn: ["DISPOSED", "RETIRED", "CANCELLED"] }, ...(au.location ? { location: { equals: au.location, mode: "insensitive" } } : {}) }, orderBy: { code: "asc" } });
  const scannedIds = new Set(au.scans.map((s) => s.assetId).filter(Boolean) as string[]);
  const extraIds = [...scannedIds].filter((id) => !scope.some((a) => a.id === id));
  const extra = extraIds.length ? await prisma.fixedAsset.findMany({ where: { id: { in: extraIds } } }) : [];
  const byId = new Map([...scope, ...extra].map((a) => [a.id, a]));
  const missing = scope.filter((a) => !scannedIds.has(a.id));
  const c = (a: { cost: Prisma.Decimal }) => toCentavos(a.cost.toString());
  const buckets = (key: (a: typeof scope[number]) => string) => {
    const m = new Map<string, Bucket>();
    for (const a of scope) {
      const k = key(a) || "Not set";
      const b = m.get(k) ?? { key: k, expected: 0, found: 0, missing: 0, cost: 0n, missingCost: 0n };
      b.expected++; b.cost += c(a);
      if (scannedIds.has(a.id)) b.found++; else { b.missing++; b.missingCost += c(a); }
      m.set(k, b);
    }
    return [...m.values()].sort((x, y) => x.key.localeCompare(y.key)).map((b) => ({ ...b, cost: fromCentavos(b.cost), missingCost: fromCentavos(b.missingCost), pct: b.expected ? Math.round((b.found / b.expected) * 100) : 0 }));
  };
  const scans = au.scans.map((s) => {
    const a = s.assetId ? byId.get(s.assetId) : null;
    return { id: s.id, tagText: s.tagText, result: s.result, location: s.location, condition: s.condition, note: s.note, scannedAt: s.scannedAt, asset: a ? { id: a.id, code: a.code, name: a.name, expectedLocation: a.location } : null };
  });
  const conditions: Record<string, number> = {};
  for (const s of au.scans) if (s.assetId) conditions[s.condition ?? "NOT_GIVEN"] = (conditions[s.condition ?? "NOT_GIVEN"] ?? 0) + 1;
  const found = scope.filter((a) => scannedIds.has(a.id)).length;
  return {
    audit: { id: au.id, number: au.number, name: au.name, location: au.location, status: au.status, createdAt: au.createdAt, closedAt: au.closedAt },
    totals: {
      expected: scope.length, found, missing: missing.length, wrongLocation: scans.filter((s) => s.result === "WRONG_LOCATION").length,
      unknown: scans.filter((s) => s.result === "UNKNOWN").length, outOfScope: extra.length,
      pctFound: scope.length ? Math.round((found / scope.length) * 100) : 0,
      missingCost: fromCentavos(missing.reduce((s, a) => s + c(a), 0n)), expectedCost: fromCentavos(scope.reduce((s, a) => s + c(a), 0n)),
      neverTagged: scope.filter((a) => !a.taggedAt).length,
    },
    conditions, byLocation: buckets((a) => a.location ?? ""), byCategory: buckets((a) => a.category ?? ""),
    missing: missing.map((a) => ({ id: a.id, code: a.code, name: a.name, location: a.location, custodianCode: a.custodianCode, cost: fromCentavos(c(a)), lastSeenAt: a.lastSeenAt })),
    scans,
  };
}
