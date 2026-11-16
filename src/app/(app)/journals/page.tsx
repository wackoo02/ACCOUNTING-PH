import Link from "next/link";
import type { JournalStatus, Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";

type SP = Promise<Record<string, string | undefined>>;

export default async function Journals({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.JournalEntryWhereInput = { organizationId: ctx.org.id };
  if (sp.status && ["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"].includes(sp.status)) where.status = sp.status as JournalStatus;
  if (sp.q) where.OR = [{ memo: { contains: sp.q, mode: "insensitive" } }, { number: { contains: sp.q, mode: "insensitive" } }, { reference: { contains: sp.q, mode: "insensitive" } }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const entries = await prisma.journalEntry.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 200 });
  return (
    <>
      <div className="top"><h1>Journal Entries</h1><Link className="btn" href="/journals/new">New journal entry</Link></div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., description or reference" /></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option><option>DRAFT</option><option value="PENDING_APPROVAL">PENDING APPROVAL</option><option>POSTED</option><option>VOID</option></select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Posting date</th><th>No.</th><th>Reference</th><th>Description</th><th>Source</th><th>Status</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{fmtDate(e.date)}</td><td><Link href={`/journals/${e.id}`}>{e.number}</Link></td><td>{e.reference}</td><td>{e.memo}</td>
              <td className="muted">{e.source}</td><td><span className={`badge ${e.status}`}>{e.status.replace("_", " ")}</span></td>
              <td className="num">{formatPeso(toCentavos(e.totalDebit.toString()))}</td>
            </tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={7} className="muted">No entries found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
