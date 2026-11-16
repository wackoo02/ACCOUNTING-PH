// Save master records (manual form or bulk upload). Upsert by code, scoped to the company.
import { Prisma, type DimensionType } from "@prisma/client";
import { prisma } from "../db";
import { MASTERS, type MasterKind } from "./config";

type Tx = Prisma.TransactionClient;

export class MasterError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); }
}

// Optional in the sheet but required in the database (it has a default): a blank cell keeps the default.
const NOT_NULL = new Set(["currencyCode"]);

/** Fields that are optional in the sheet: a blank cell means "clear it" on update. */
function blanksToNull(kind: MasterKind, data: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...data };
  for (const f of MASTERS[kind].fields) {
      if (!(f.key in out) && !f.required && (f.type === "text" || f.type === "date") && f.key !== "parentCode" && !NOT_NULL.has(f.key)) out[f.key] = null;
  }
  return out;
}

async function saveAccount(tx: Tx, organizationId: string, d: Record<string, unknown>, codeToId: Map<string, string>) {
  const code = d.code as string;
  const type = d.type as "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  const normalBalance = (d.normalBalance as "DEBIT" | "CREDIT" | undefined) ?? (type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT");
  let parentId: string | null = null;
  if (d.parentCode) {
    const pc = String(d.parentCode).toUpperCase();
    if (pc === code) throw new MasterError([`${code}: an account cannot be its own parent`]);
    parentId = codeToId.get(pc) ?? (await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: pc } } }))?.id ?? null;
    if (!parentId) throw new MasterError([`${code}: parent account ${pc} not found`]);
  }
  const existing = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code } }, include: { _count: { select: { lines: true } } } });
  if (existing && existing._count.lines > 0) {
    if (existing.type !== type) throw new MasterError([`${code}: type cannot change because the account already has transactions`]);
    if (d.isPostable === false) throw new MasterError([`${code}: cannot become a header account because it already has transactions`]);
  }
  const data = {
    name: d.name as string,
    type,
    ifrsGroup: d.ifrsGroup as string,
    isCurrent: (d.isCurrent as boolean | undefined) ?? null,
    normalBalance,
    parentId,
    isPostable: (d.isPostable as boolean | undefined) ?? true,
    allowManualPosting: (d.allowManualPosting as boolean | undefined) ?? true,
    currencyCode: d.currencyCode ? String(d.currencyCode).toUpperCase() : null,
    isActive: (d.isActive as boolean | undefined) ?? true,
    description: (d.description as string | undefined) ?? null,
  };
  const a = existing
    ? await tx.account.update({ where: { id: existing.id }, data })
    : await tx.account.create({ data: { ...data, organizationId, code } });
  codeToId.set(code, a.id);
  return a;
}

async function saveDimension(tx: Tx, organizationId: string, d: Record<string, unknown>, codeToId: Map<string, string>) {
  const type = d.type as DimensionType;
  const code = d.code as string;
  let parentId: string | null = null;
  if (d.parentCode) {
    const pc = String(d.parentCode).toUpperCase();
    if (pc === code) throw new MasterError([`${type} ${code}: cannot be its own parent`]);
    parentId = codeToId.get(`${type}:${pc}`) ?? (await tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId, type, code: pc } } }))?.id ?? null;
    if (!parentId) throw new MasterError([`${type} ${code}: parent ${pc} not found`]);
  }
  const data = { name: d.name as string, parentId, manager: (d.manager as string | undefined) ?? null, isActive: (d.isActive as boolean | undefined) ?? true };
  const r = await tx.dimensionValue.upsert({
    where: { organizationId_type_code: { organizationId, type, code } },
    create: { ...data, organizationId, type, code },
    update: data,
  });
  codeToId.set(`${type}:${code}`, r.id);
  return r;
}

async function saveBankAccount(tx: Tx, organizationId: string, d: Record<string, unknown>) {
  const code = d.code as string;
  const glCode = String(d.glAccountCode ?? "").trim();
  const gl = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: glCode } } });
  const errs: string[] = [];
  if (!gl) errs.push(`${code}: GL account ${glCode} not found`);
  else {
    if (d.kind === "CREDIT_CARD") {
      if (gl.type !== "LIABILITY" || !gl.isPostable) errs.push(`${code}: a credit card needs a postable liability account (e.g. 2015 Corporate Credit Card Payable)`);
    } else if (gl.type !== "ASSET" || !gl.isPostable) errs.push(`${code}: GL account ${glCode} must be a postable asset account (cash and cash equivalents)`);
    const other = await tx.bankAccount.findFirst({ where: { organizationId, glAccountId: gl.id, code: { not: code } } });
    if (other) errs.push(`${code}: GL account ${glCode} is already used by ${other.code}. Give each bank account its own GL account.`);
  }
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const currencyCode = d.currencyCode ? String(d.currencyCode).toUpperCase() : gl?.currencyCode ?? org.baseCurrency;
  if (gl && (gl.currencyCode ?? org.baseCurrency) !== currencyCode) errs.push(`${code}: currency ${currencyCode} does not match GL account ${glCode} (${gl.currencyCode ?? org.baseCurrency})`);
  if (currencyCode !== org.baseCurrency && !(await tx.currency.findUnique({ where: { organizationId_code: { organizationId, code: currencyCode } } }))) errs.push(`${code}: add ${currencyCode} to Currencies first`);
  if (errs.length) throw new MasterError(errs);
  const existing = await tx.bankAccount.findUnique({ where: { organizationId_code: { organizationId, code } } });
  if (existing && existing.glAccountId !== gl!.id) {
    const used = await tx.cashTransaction.count({ where: { organizationId, OR: [{ bankAccountId: existing.id }, { toBankAccountId: existing.id }] } })
      + await tx.bankStatement.count({ where: { organizationId, bankAccountId: existing.id } });
    if (used) throw new MasterError([`${code}: the GL account cannot change because the account already has transactions`]);
  }
  const data = {
    name: d.name as string, kind: d.kind as string, glAccountId: gl!.id, currencyCode,
    bankName: (d.bankName as string | undefined) ?? null, branchName: (d.branchName as string | undefined) ?? null,
    accountNumber: (d.accountNumber as string | undefined) ?? null, custodian: (d.custodian as string | undefined) ?? null,
    nextCheckNo: (d.nextCheckNo as number | undefined) ?? null, fundLimit: (d.fundLimit as number | string | undefined) ?? 0,
    isActive: (d.isActive as boolean | undefined) ?? true,
  };
  return tx.bankAccount.upsert({ where: { organizationId_code: { organizationId, code } }, create: { ...data, organizationId, code }, update: data });
}

async function saveOne(tx: Tx, kind: MasterKind, organizationId: string, d: Record<string, unknown>, codeToId: Map<string, string>) {
  if (kind === "accounts") return saveAccount(tx, organizationId, d, codeToId);
  if (kind === "dimensions") return saveDimension(tx, organizationId, d, codeToId);
  if (kind === "banks") return saveBankAccount(tx, organizationId, d);
  const code = d.code as string;
  const data = blanksToNull(kind, d);
  delete data.code;
  const where = { organizationId_code: { organizationId, code } };
  // Prisma delegates share a shape; the cast keeps this generic across the five tables.
  const delegate = (tx as unknown as Record<string, { upsert: (a: unknown) => Promise<unknown> }>)[MASTERS[kind].model];
  return delegate.upsert({ where, create: { ...data, organizationId, code }, update: data });
}

/** Save one record from the manual form. */
export async function saveMaster(kind: MasterKind, organizationId: string, userId: string, data: Record<string, unknown>, originalCode?: string) {
  return prisma.$transaction(async (tx) => {
    if (originalCode && originalCode !== data.code) {
      throw new MasterError(["Codes cannot be changed once created. Create a new record and deactivate this one."]);
    }
    const before = await findExisting(tx, kind, organizationId, data);
    const r = await saveOne(tx, kind, organizationId, data, new Map());
    await tx.auditLog.create({ data: {
      organizationId, userId, action: before ? `${kind}.update` : `${kind}.create`, entity: kind, entityId: keyOf(kind, data),
      before: before ? JSON.parse(JSON.stringify(before)) : undefined, after: JSON.parse(JSON.stringify(r)),
    } });
    return r;
  });
}

/** Save many rows from an upload. All or nothing: if any row fails, nothing is saved. */
export async function importMasters(kind: MasterKind, organizationId: string, userId: string, rows: Record<string, unknown>[]) {
  // Parents first so a sheet can create a header and its children in one go.
  const ordered = kind === "accounts" || kind === "dimensions" ? sortParentsFirst(rows, (r) => keyOf(kind, r), (r) => (r.parentCode ? keyOf(kind, { ...r, code: String(r.parentCode).toUpperCase() }) : null)) : rows;
  const seen = new Set<string>();
  for (const r of rows) {
    const c = keyOf(kind, r);
    if (seen.has(c)) throw new MasterError([`Code ${c} appears more than once in the file`]);
    seen.add(c);
  }
  return prisma.$transaction(async (tx) => {
    let created = 0, updated = 0;
    const codeToId = new Map<string, string>();
    const model = MASTERS[kind].model;
    const existing = await (tx as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[model].findMany({ where: { organizationId } });
    const byKey = new Map(existing.map((x) => [keyOf(kind, x), x]));
    for (const r of ordered) {
      const after = await saveOne(tx, kind, organizationId, r, codeToId);
      const before = byKey.get(keyOf(kind, r));
      if (before) updated++; else created++;
      await tx.auditLog.create({ data: {
        organizationId, userId, action: before ? `${kind}.update` : `${kind}.create`, entity: kind, entityId: keyOf(kind, r),
        before: before ? JSON.parse(JSON.stringify(before)) : undefined, after: JSON.parse(JSON.stringify(after)), details: { via: "excel upload" },
      } });
    }
    await tx.auditLog.create({ data: { organizationId, userId, action: `${kind}.import`, entity: kind, entityId: "bulk", details: { created, updated } } });
    return { created, updated };
  }, { timeout: 60_000 });
}

function keyOf(kind: MasterKind, r: Record<string, unknown>) {
  return kind === "dimensions" ? `${r.type}:${r.code}` : String(r.code);
}

async function findExisting(tx: Tx, kind: MasterKind, organizationId: string, d: Record<string, unknown>) {
  if (kind === "dimensions") return tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId, type: d.type as DimensionType, code: d.code as string } } });
  const delegate = (tx as unknown as Record<string, { findUnique: (a: unknown) => Promise<unknown> }>)[MASTERS[kind].model];
  return delegate.findUnique({ where: { organizationId_code: { organizationId, code: d.code } } });
}

function sortParentsFirst(rows: Record<string, unknown>[], key: (r: Record<string, unknown>) => string, parentKey: (r: Record<string, unknown>) => string | null) {
  const byCode = new Map(rows.map((r) => [key(r), r]));
  const out: Record<string, unknown>[] = [];
  const done = new Set<string>();
  const visit = (r: Record<string, unknown>, stack: Set<string>) => {
    const c = key(r);
    if (done.has(c)) return;
    if (stack.has(c)) throw new MasterError([`${c} has a circular parent chain`]);
    stack.add(c);
    const pk = parentKey(r);
    const p = pk ? byCode.get(pk) : undefined;
    if (p) visit(p, stack);
    done.add(c);
    out.push(r);
  };
  rows.forEach((r) => visit(r, new Set()));
  return out;
}
