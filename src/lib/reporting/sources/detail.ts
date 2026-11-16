// Detail listings: general ledger lines (GL listing / account ledger) and the journal entry register.
// The user picks which columns to show, in what order, how to sort and where to subtotal.
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { toCentavos } from "../../money";
import { DIMENSIONS, type DimKey } from "../../ledger/dimensions";
import type { RunContext } from "../context";
import type { Cell, CellKind, Column, ReportResult, Row } from "../result";
import { lineWhere, loadParties, loadScopes, PARTY_LABEL } from "../scope";
import { fieldLabel, subtitle } from "./balances";
import { fmtIso } from "../periods";

const MAX_ROWS = 5000;
const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");

export type FieldDef = { id: string; label: string; kind: CellKind; sum?: boolean };

export const GL_FIELDS: FieldDef[] = [
  { id: "date", label: "Posting date", kind: "date" },
  { id: "transactionDate", label: "Transaction date", kind: "date" },
  { id: "number", label: "JE no.", kind: "text" },
  { id: "status", label: "Status", kind: "text" },
  { id: "source", label: "Source", kind: "text" },
  { id: "entity", label: "Entity", kind: "text" },
  { id: "accountCode", label: "Account code", kind: "text" },
  { id: "accountName", label: "Account name", kind: "text" },
  { id: "ifrsGroup", label: "IFRS line item", kind: "text" },
  { id: "memo", label: "Narration", kind: "text" },
  { id: "description", label: "Line description", kind: "text" },
  { id: "reference", label: "Reference", kind: "text" },
  { id: "party", label: "Customer / vendor / employee", kind: "text" },
  ...DIMENSIONS.map((d) => ({ id: d.key, label: d.label, kind: "text" as const })),
  { id: "currency", label: "Currency", kind: "text" },
  { id: "fxRate", label: "Rate", kind: "number" },
  { id: "fxDebit", label: "Debit (currency)", kind: "amount" },
  { id: "fxCredit", label: "Credit (currency)", kind: "amount" },
  { id: "debit", label: "Debit", kind: "amount", sum: true },
  { id: "credit", label: "Credit", kind: "amount", sum: true },
  { id: "net", label: "Net (Dr - Cr)", kind: "amount", sum: true },
  { id: "balance", label: "Running balance", kind: "amount" },
  { id: "cleared", label: "Cleared on", kind: "date" },
  { id: "preparedBy", label: "Prepared by", kind: "text" },
  { id: "approvedBy", label: "Approved by", kind: "text" },
];
export const GL_DEFAULT = ["date", "number", "accountCode", "accountName", "memo", "reference", "debit", "credit", "balance"];

export const JE_FIELDS: FieldDef[] = [
  { id: "number", label: "JE no.", kind: "text" },
  { id: "date", label: "Posting date", kind: "date" },
  { id: "transactionDate", label: "Transaction date", kind: "date" },
  { id: "entity", label: "Entity", kind: "text" },
  { id: "memo", label: "Narration", kind: "text" },
  { id: "reference", label: "Reference", kind: "text" },
  { id: "source", label: "Source", kind: "text" },
  { id: "status", label: "Status", kind: "text" },
  { id: "lines", label: "Lines", kind: "number" },
  { id: "totalDebit", label: "Total debit", kind: "amount", sum: true },
  { id: "totalCredit", label: "Total credit", kind: "amount", sum: true },
  { id: "preparedBy", label: "Prepared by", kind: "text" },
  { id: "submittedAt", label: "Submitted", kind: "date" },
  { id: "approvedBy", label: "Approved / posted by", kind: "text" },
  { id: "postedAt", label: "Posted", kind: "date" },
  { id: "reversal", label: "Reversal of", kind: "text" },
];
export const JE_DEFAULT = ["number", "date", "memo", "reference", "source", "status", "totalDebit", "preparedBy", "approvedBy"];

const pick = (all: FieldDef[], ids: string[], fallback: string[]) => {
  const chosen = (ids.length ? ids : fallback).map((id) => all.find((f) => f.id === id)).filter(Boolean) as FieldDef[];
  return chosen.length ? chosen : (fallback.map((id) => all.find((f) => f.id === id)!) as FieldDef[]);
};
const toCols = (fields: FieldDef[]): Column[] => fields.map((f) => ({ key: f.id, head: [f.label], kind: f.kind, align: f.kind === "amount" || f.kind === "number" ? "right" : "left" }));

async function userNames(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

export async function runGlDetail(ctx: RunContext): Promise<ReportResult> {
  const { def } = ctx;
  const p = ctx.periods[0];
  const scopes = await loadScopes(ctx.orgs, def.filters);
  const fields = pick(GL_FIELDS, def.columns, GL_DEFAULT);
  const cols = toCols(fields);
  const statuses = def.filters.statuses?.length ? def.filters.statuses : ["POSTED"];
  const group = def.groupDetailBy;
  const needBalance = fields.some((f) => f.id === "balance");
  type L = Awaited<ReturnType<typeof fetchLines>>[number] & { orgName: string; scopeIdx: number };
  const fetchLines = (where: Prisma.JournalLineWhereInput) => prisma.journalLine.findMany({
    where, include: { journalEntry: true, account: true }, take: MAX_ROWS + 1,
    orderBy: def.sort === "number" ? [{ journalEntry: { number: "asc" } }, { lineNo: "asc" }]
      : def.sort === "account" ? [{ account: { code: "asc" } }, { journalEntry: { date: "asc" } }, { lineNo: "asc" }]
      : def.sort === "amount" ? [{ debit: "desc" }, { credit: "desc" }]
      : [{ journalEntry: { date: "asc" } }, { journalEntry: { number: "asc" } }, { lineNo: "asc" }],
  });
  let lines: L[] = [];
  let truncated = false;
  const openings = new Map<string, bigint>(); // group key -> opening (debit positive)
  for (const [i, s] of scopes.entries()) {
    const got = await fetchLines(lineWhere(s, def.filters, { date: { gte: p.from, lte: p.to }, statuses }));
    if (got.length > MAX_ROWS) truncated = true;
    lines.push(...got.slice(0, MAX_ROWS).map((l) => ({ ...l, orgName: s.org.name, scopeIdx: i })));
    if (needBalance && (group === "account" || group === "none") && p.from.getUTCFullYear() > 1900) {
      const before = await prisma.journalLine.groupBy({ by: ["accountId"], where: lineWhere(s, def.filters, { date: { lt: p.from }, statuses: ["POSTED"] }), _sum: { debit: true, credit: true } });
      for (const b of before) {
        const a = s.accountById.get(b.accountId)!;
        const k = group === "account" ? a.code : "";
        openings.set(k, (openings.get(k) ?? 0n) + c(b._sum.debit) - c(b._sum.credit));
      }
    }
  }
  if (scopes.length > 1) {
    const dateKey = (l: L) => fmtIso(l.journalEntry.date) + l.journalEntry.number + String(l.lineNo).padStart(4, "0");
    if (def.sort === "date") lines.sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    if (def.sort === "number") lines.sort((a, b) => a.journalEntry.number.localeCompare(b.journalEntry.number) || a.lineNo - b.lineNo);
    if (def.sort === "account") lines.sort((a, b) => a.account.code.localeCompare(b.account.code) || dateKey(a).localeCompare(dateKey(b)));
    if (lines.length > MAX_ROWS) { lines = lines.slice(0, MAX_ROWS); truncated = true; }
  }
  const parties = new Map(await Promise.all(scopes.map(async (s) => [s.org.id, await loadParties(s.org.id)] as const)));
  const names = await userNames(lines.flatMap((l) => [l.journalEntry.createdById, l.journalEntry.postedById]));

  const groupOf = (l: L): { key: string; label: string } => {
    const s = scopes[l.scopeIdx];
    switch (group) {
      case "none": return { key: "", label: "" };
      case "account": return { key: l.account.code, label: `${l.account.code} · ${l.account.name}` };
      case "entry": return { key: `${l.organizationId}:${l.journalEntry.number}`, label: `${l.journalEntry.number} · ${l.journalEntry.memo}` };
      case "entity": return { key: l.organizationId, label: s.org.name };
      case "type": return { key: l.account.type, label: l.account.type };
      case "ifrsGroup": return { key: l.account.ifrsGroup, label: l.account.ifrsGroup };
      case "party": case "partyType": {
        if (!l.partyType) return { key: "", label: "(no party)" };
        if (group === "partyType") return { key: l.partyType, label: PARTY_LABEL[l.partyType] ?? l.partyType };
        const pi = parties.get(l.organizationId)?.get(`${l.partyType}:${l.partyId}`);
        return { key: `${l.partyType}:${pi?.code ?? l.partyId}`, label: pi ? `${pi.code} · ${pi.name}` : `${l.partyType} ${l.partyId}` };
      }
      default: {
        const id = (l as unknown as Record<string, string | null>)[group];
        const v = id ? s.dimById.get(id) : null;
        return v ? { key: v.code, label: `${v.code} · ${v.name}` } : { key: "", label: "(not tagged)" };
      }
    }
  };
  if (group !== "none") {
    const keyed = lines.map((l, i) => ({ l, i, g: groupOf(l) }));
    keyed.sort((a, b) => a.g.key.localeCompare(b.g.key) || a.i - b.i);
    lines = keyed.map((x) => x.l);
  }

  const cellOf = (l: L, f: FieldDef, balance: bigint): Cell => {
    const je = l.journalEntry, s = scopes[l.scopeIdx];
    switch (f.id) {
      case "date": return fmtIso(je.date);
      case "transactionDate": return fmtIso(je.transactionDate);
      case "number": return je.number;
      case "status": return je.status;
      case "source": return je.source;
      case "entity": return l.orgName;
      case "accountCode": return l.account.code;
      case "accountName": return l.account.name;
      case "ifrsGroup": return l.account.ifrsGroup;
      case "memo": return je.memo;
      case "description": return l.description;
      case "reference": return je.reference;
      case "party": {
        if (!l.partyType) return null;
        const pi = parties.get(l.organizationId)?.get(`${l.partyType}:${l.partyId}`);
        return pi ? `${pi.code} · ${pi.name}` : `${l.partyType} ${l.partyId}`;
      }
      case "currency": return l.currencyCode;
      case "fxRate": return l.fxRate.toString();
      case "fxDebit": return c(l.fxDebit).toString();
      case "fxCredit": return c(l.fxCredit).toString();
      case "debit": return c(l.debit).toString();
      case "credit": return c(l.credit).toString();
      case "net": return (c(l.debit) - c(l.credit)).toString();
      case "balance": return balance.toString();
      case "cleared": return l.clearedAt ? fmtIso(l.clearedAt) : null;
      case "preparedBy": return names.get(je.createdById) ?? null;
      case "approvedBy": return je.postedById ? names.get(je.postedById) ?? null : null;
      default: {
        const id = (l as unknown as Record<string, string | null>)[f.id];
        const v = id ? s.dimById.get(id) : null;
        return v ? `${v.code} · ${v.name}` : null;
      }
    }
  };

  const rows: Row[] = [];
  const sums = (ls: L[]) => fields.map((f) => (f.sum ? ls.reduce((t, l) => t + (f.id === "debit" ? c(l.debit) : f.id === "credit" ? c(l.credit) : c(l.debit) - c(l.credit)), 0n).toString() : null));
  const balIdx = fields.findIndex((f) => f.id === "balance");
  let current: { key: string; label: string } | null = null;
  let bucket: L[] = [];
  let bal = 0n;
  const flush = () => {
    if (current && group !== "none") {
      const cells = sums(bucket);
      if (balIdx >= 0) cells[balIdx] = bal.toString();
      rows.push({ key: `t:${current.key}:${rows.length}`, kind: "subtotal", depth: 0, label: `Total ${current.label}`, cells });
    }
    bucket = [];
  };
  for (const l of lines) {
    const g = groupOf(l);
    if (!current || g.key !== current.key) {
      flush();
      current = g;
      bal = openings.get(group === "account" ? g.key : "") ?? 0n;
      if (group !== "none") rows.push({ key: `h:${g.key}:${rows.length}`, kind: "header", depth: 0, label: g.label, cells: fields.map(() => null) });
      if (balIdx >= 0 && openings.has(group === "account" ? g.key : "") && (group === "account" || rows.length === 0)) {
        const cells: Cell[] = fields.map(() => null); cells[balIdx] = bal.toString();
        rows.push({ key: `o:${g.key}:${rows.length}`, kind: "detail", depth: 1, label: "Opening balance", cells });
      }
    }
    bal += c(l.debit) - c(l.credit);
    bucket.push(l);
    const link = l.organizationId === ctx.currentOrgId ? `/journals/${l.journalEntryId}` : undefined;
    rows.push({ key: l.id, kind: "line", depth: group === "none" ? 0 : 1, label: "", cells: fields.map((f) => cellOf(l, f, bal)), link });
  }
  flush();
  if (lines.length) {
    const cells = sums(lines);
    rows.push({ key: "grand", kind: "total", depth: 0, label: "Total", cells });
  } else ctx.notes.push("No journal lines match this report's filters.");
  if (truncated) ctx.notes.push(`Showing the first ${MAX_ROWS.toLocaleString()} lines. Narrow the dates or filters to see the rest.`);
  if (needBalance && group !== "account") ctx.notes.push("Running balance adds up every line shown. Group by account for a balance per account.");
  const statusNote = statuses.length === 1 && statuses[0] === "POSTED" ? "posted entries" : statuses.join(", ").toLowerCase().replace(/_/g, " ") + " entries";
  return { title: def.title || "General ledger listing", subtitle: `${subtitle(ctx)} · ${p.label} · ${statusNote}${group !== "none" ? ` · by ${fieldLabel(group).toLowerCase()}` : ""}`, labelHead: null, columns: cols, rows, notes: ctx.notes, truncated };
}

export async function runJournalRegister(ctx: RunContext): Promise<ReportResult> {
  const { def } = ctx;
  const p = ctx.periods[0];
  const scopes = await loadScopes(ctx.orgs, def.filters);
  const fields = pick(JE_FIELDS, def.columns, JE_DEFAULT);
  const cols = toCols(fields);
  const statuses = def.filters.statuses?.length ? def.filters.statuses : ["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"];
  type E = Prisma.JournalEntryGetPayload<{ include: { _count: { select: { lines: true } }; reversalOf: { select: { number: true } } } }> & { orgName: string };
  let entries: E[] = [];
  let truncated = false;
  for (const s of scopes) {
    // Line-level filters (accounts, dimensions, parties, text) select entries that have a matching line.
    const lw = lineWhere(s, def.filters, { statuses });
    const lineCond: Prisma.JournalLineWhereInput = { ...(lw.accountId ? { accountId: lw.accountId } : {}), ...(lw.AND ? { AND: lw.AND } : {}) };
    const hasLineFilter = Object.keys(lineCond).length > 0;
    const je = lw.journalEntry as Prisma.JournalEntryWhereInput;
    const got = await prisma.journalEntry.findMany({
      where: { organizationId: s.org.id, date: { gte: p.from, lte: p.to }, status: je.status, ...(je.book ? { book: je.book } : {}), ...(je.source ? { source: je.source } : {}), ...(hasLineFilter ? { lines: { some: lineCond } } : {}) },
      include: { _count: { select: { lines: true } }, reversalOf: { select: { number: true } } },
      orderBy: def.sort === "amount" ? [{ totalDebit: "desc" }] : def.sort === "number" ? [{ number: "asc" }] : [{ date: "asc" }, { number: "asc" }],
      take: MAX_ROWS + 1,
    });
    if (got.length > MAX_ROWS) truncated = true;
    entries.push(...got.slice(0, MAX_ROWS).map((e) => ({ ...e, orgName: s.org.name })));
  }
  if (scopes.length > 1 && def.sort !== "amount") entries.sort((a, b) => (def.sort === "number" ? a.number.localeCompare(b.number) : fmtIso(a.date).localeCompare(fmtIso(b.date)) || a.number.localeCompare(b.number)));
  if (entries.length > MAX_ROWS) { entries = entries.slice(0, MAX_ROWS); truncated = true; }
  const names = await userNames(entries.flatMap((e) => [e.createdById, e.postedById]));
  const cellOf = (e: E, f: FieldDef): Cell => {
    switch (f.id) {
      case "number": return e.number;
      case "date": return fmtIso(e.date);
      case "transactionDate": return fmtIso(e.transactionDate);
      case "entity": return e.orgName;
      case "memo": return e.memo;
      case "reference": return e.reference;
      case "source": return e.source;
      case "status": return e.status;
      case "lines": return e._count.lines;
      case "totalDebit": return c(e.totalDebit).toString();
      case "totalCredit": return c(e.totalCredit).toString();
      case "preparedBy": return names.get(e.createdById) ?? null;
      case "submittedAt": return e.submittedAt ? fmtIso(e.submittedAt) : null;
      case "approvedBy": return e.postedById ? names.get(e.postedById) ?? null : null;
      case "postedAt": return e.postedAt ? fmtIso(e.postedAt) : null;
      case "reversal": return e.reversalOf?.number ?? null;
      default: return null;
    }
  };
  const grp = def.groupDetailBy === "entity" || (def.groupDetailBy as string) === "source" ? def.groupDetailBy : "none";
  const rows: Row[] = [];
  const sum = (es: E[]) => fields.map((f) => (f.sum ? es.reduce((t, e) => t + c(f.id === "totalDebit" ? e.totalDebit : e.totalCredit), 0n).toString() : null));
  if (grp === "entity" && scopes.length > 1) {
    for (const s of scopes) {
      const es = entries.filter((e) => e.organizationId === s.org.id);
      if (!es.length) continue;
      rows.push({ key: `h:${s.org.id}`, kind: "header", depth: 0, label: s.org.name, cells: fields.map(() => null) });
      for (const e of es) rows.push({ key: e.id, kind: "line", depth: 1, label: "", cells: fields.map((f) => cellOf(e, f)), link: e.organizationId === ctx.currentOrgId ? `/journals/${e.id}` : undefined });
      rows.push({ key: `t:${s.org.id}`, kind: "subtotal", depth: 0, label: `Total ${s.org.name}`, cells: sum(es) });
    }
  } else {
    for (const e of entries) rows.push({ key: e.id, kind: "line", depth: 0, label: "", cells: fields.map((f) => cellOf(e, f)), link: e.organizationId === ctx.currentOrgId ? `/journals/${e.id}` : undefined });
  }
  if (entries.length) rows.push({ key: "grand", kind: "total", depth: 0, label: `Total (${entries.length} entries)`, cells: sum(entries) });
  else ctx.notes.push("No journal entries match this report's filters.");
  if (truncated) ctx.notes.push(`Showing the first ${MAX_ROWS.toLocaleString()} entries. Narrow the dates or filters to see the rest.`);
  return { title: def.title || "Journal entry register", subtitle: `${subtitle(ctx)} · ${p.label}`, labelHead: null, columns: cols, rows, notes: ctx.notes, truncated };
}

export type { DimKey };
