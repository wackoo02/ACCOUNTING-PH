// Aging of customer / vendor / employee balances from the general ledger, as of a date.
// Payments and credits are applied to the oldest open items first (FIFO). When the AR and AP
// modules arrive they can register their own invoice-based aging source next to this one.
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { toCentavos } from "../../money";
import type { RunContext } from "../context";
import type { Cell, Column, ReportResult, Row } from "../result";
import { lineWhere, loadParties, loadScopes, PARTY_LABEL, type OrgScope } from "../scope";
import { subtitle } from "./balances";
import { fmtIso } from "../periods";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const DAY = 864e5;

type Item = { amount: bigint; date: Date; due: Date; number: string; entryId: string; orgId: string };

/** Open items left after applying the opposite-side amounts to the oldest items first. */
export function openItems(items: Item[]): Item[] {
  const bal = items.reduce((s, i) => s + i.amount, 0n);
  if (bal === 0n) return [];
  const sameSide = items.filter((i) => (bal > 0n ? i.amount > 0n : i.amount < 0n)).sort((a, b) => a.date.getTime() - b.date.getTime() || a.number.localeCompare(b.number));
  let toApply = items.filter((i) => (bal > 0n ? i.amount < 0n : i.amount > 0n)).reduce((s, i) => s + (i.amount < 0n ? -i.amount : i.amount), 0n);
  const out: Item[] = [];
  for (const it of sameSide) {
    const abs = it.amount < 0n ? -it.amount : it.amount;
    if (toApply >= abs) { toApply -= abs; continue; }
    const left = abs - toApply; toApply = 0n;
    out.push({ ...it, amount: bal > 0n ? left : -left });
  }
  return out;
}

export async function runAging(ctx: RunContext): Promise<ReportResult> {
  const { def } = ctx;
  const asOf = ctx.periods[0].to;
  const f = def.filters;
  const scopes = await loadScopes(ctx.orgs, f);
  const buckets = [...new Set(def.aging.buckets)].sort((a, b) => a - b);
  const basis = def.aging.basis;
  const dueBasis = basis === "dueDate";
  const labels = [dueBasis ? "Not yet due" : `0-${buckets[0]} days`];
  for (let i = 0; i < buckets.length; i++) {
    const lo = (dueBasis && i === 0 ? 1 : buckets[i] + 1), hi = buckets[i + 1];
    if (dueBasis && i === 0) labels.push(`1-${buckets[0]} days past due`);
    if (hi !== undefined) labels.push(dueBasis ? `${buckets[i] + 1}-${hi} days past due` : `${lo}-${hi} days`);
  }
  labels.push(dueBasis ? `Over ${buckets[buckets.length - 1]} days past due` : `Over ${buckets[buckets.length - 1]} days`);
  const bucketOf = (days: number) => {
    if (dueBasis) {
      if (days <= 0) return 0;
      for (let i = 0; i < buckets.length; i++) if (days <= buckets[i]) return i + 1;
      return buckets.length + 1;
    }
    for (let i = 0; i < buckets.length; i++) if (days <= buckets[i]) return i;
    return buckets.length;
  };

  const multi = scopes.length > 1;
  const showItems = def.aging.showItems;
  const cols: Column[] = [
    { key: "code", head: ["Code"], kind: "text" },
    { key: "name", head: [showItems ? "Name / document" : "Name"], kind: "text" },
    { key: "type", head: ["Type"], kind: "text" },
    ...(multi ? [{ key: "entity", head: ["Entity"], kind: "text" as const }] : []),
    ...(showItems ? [{ key: "date", head: [basis === "date" ? "Posting date" : "Document date"], kind: "date" as const }, { key: "due", head: ["Due date"], kind: "date" as const }, { key: "days", head: [dueBasis ? "Days past due" : "Age (days)"], kind: "number" as const }] : []),
    ...labels.map((l, i) => ({ key: `b${i}`, head: [l], kind: "amount" as const, align: "right" as const })),
    { key: "total", head: ["Total"], kind: "amount", align: "right" },
  ];
  const nb = labels.length;
  const amountStart = cols.length - nb - 1;
  const rows: Row[] = [];
  const grand = new Array<bigint>(nb + 1).fill(0n);
  let partyCount = 0;

  const groups: { s: OrgScope; key: string; type: string; id: string; items: Item[] }[] = [];
  for (const s of scopes) {
    let accountIds = s.allowedAccountIds;
    if (!accountIds) {
      // Default control accounts: AR for customers, AP for vendors; otherwise every balance sheet account.
      const types = f.partyTypes ?? [];
      const roles = types.length === 1 && types[0] === "CUSTOMER" ? ["AR_CONTROL"] : types.length === 1 && types[0] === "VENDOR" ? ["AP_CONTROL"] : null;
      accountIds = s.accounts.filter((a) => (roles ? roles.includes(a.systemRole ?? "") : a.type === "ASSET" || a.type === "LIABILITY")).map((a) => a.id);
      if (roles) ctx.notes.push(`${s.org.name}: aging uses the ${roles[0] === "AR_CONTROL" ? "accounts receivable" : "accounts payable"} control account. Pick accounts in the filters to age other accounts.`);
    }
    const where: Prisma.JournalLineWhereInput = { ...lineWhere(s, f, { date: { lte: asOf } }), accountId: { in: accountIds }, partyType: { not: null }, partyId: { not: null } };
    const lines = await prisma.journalLine.findMany({ where, include: { journalEntry: { select: { date: true, transactionDate: true, number: true } } } });
    const parties = await loadParties(s.org.id);
    const by = new Map<string, { type: string; id: string; items: Item[] }>();
    for (const l of lines) {
      const p = parties.get(`${l.partyType}:${l.partyId}`);
      const key = `${l.partyType}:${p?.code ?? l.partyId}`;
      const g = by.get(key) ?? { type: l.partyType!, id: l.partyId!, items: [] };
      const d = basis === "date" ? l.journalEntry.date : l.journalEntry.transactionDate;
      const due = new Date(d.getTime() + (p?.termsDays ?? 0) * DAY);
      g.items.push({ amount: c(l.debit) - c(l.credit), date: d, due, number: l.journalEntry.number, entryId: l.journalEntryId, orgId: s.org.id });
      by.set(key, g);
    }
    for (const [key, g] of by) groups.push({ s, key, ...g });
    // Parties keep their own name lookups.
    (s as OrgScope & { parties?: typeof parties }).parties = parties;
  }

  groups.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key) || a.s.org.name.localeCompare(b.s.org.name));
  for (const g of groups) {
    const open = openItems(g.items);
    if (!open.length) continue;
    const parties = (g.s as OrgScope & { parties?: Map<string, { code: string; name: string }> }).parties;
    const p = parties?.get(`${g.type}:${g.id}`);
    // Show payables and employee/partner credits as positive amounts owed.
    const sign = g.type === "VENDOR" ? -1n : 1n;
    const tot = new Array<bigint>(nb + 1).fill(0n);
    const itemRows: Row[] = [];
    for (const it of open) {
      const ref = dueBasis ? it.due : it.date;
      const days = Math.floor((asOf.getTime() - ref.getTime()) / DAY);
      const b = bucketOf(days);
      const amt = sign * it.amount;
      tot[b] += amt; tot[nb] += amt;
      if (showItems) {
        const cells: Cell[] = cols.map(() => null);
        cells[1] = it.number;
        let i = multi ? 4 : 3;
        cells[i++] = fmtIso(it.date); cells[i++] = fmtIso(it.due); cells[i++] = days;
        cells[amountStart + b] = amt.toString(); cells[amountStart + nb] = amt.toString();
        itemRows.push({ key: `${g.key}:${it.entryId}:${itemRows.length}`, kind: "detail", depth: 1, label: "", cells, link: it.orgId === ctx.currentOrgId ? `/journals/${it.entryId}` : undefined });
      }
    }
    if (tot[nb] === 0n && tot.every((x) => x === 0n)) continue;
    partyCount++;
    const cells: Cell[] = cols.map(() => null);
    cells[0] = p?.code ?? g.id; cells[1] = p?.name ?? "(not in master list)"; cells[2] = PARTY_LABEL[g.type] ?? g.type;
    if (multi) cells[3] = g.s.org.name;
    tot.forEach((v, i) => { cells[amountStart + i] = v.toString(); grand[i] += v; });
    rows.push({ key: `${g.s.org.id}:${g.key}`, kind: showItems ? "subtotal" : "line", depth: 0, label: "", cells });
    rows.push(...itemRows);
  }
  if (rows.length) {
    const cells: Cell[] = cols.map(() => null);
    cells[1] = `Total (${partyCount})`;
    grand.forEach((v, i) => { cells[amountStart + i] = v.toString(); });
    rows.push({ key: "grand", kind: "total", depth: 0, label: "", cells });
  } else ctx.notes.push("No open balances for customers, vendors or employees as of this date.");
  ctx.notes.push("Aged from journal lines tagged with a customer, vendor or employee. Credits are applied to the oldest items first.");
  if (dueBasis) ctx.notes.push("Due date = document date + the party's payment terms in the master list.");
  return { title: def.title || "Aging", subtitle: `${subtitle(ctx)} · as of ${fmtIso(asOf)}`, labelHead: null, columns: cols, rows, notes: ctx.notes };
}
