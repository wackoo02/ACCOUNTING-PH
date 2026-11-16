import { notFound, redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { JournalForm } from "@/components/JournalForm";
import { journalFormData } from "@/lib/journal-form-data";
import { DIM_KEYS } from "@/lib/ledger/dimensions";
import { fmtDate } from "@/lib/format";

export default async function EditJournal({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const e = await prisma.journalEntry.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" } }, attachments: true } });
  if (!e) notFound();
  if (e.status !== "DRAFT") redirect(`/journals/${id}`);
  const data = await journalFormData(ctx.org.id);
  const amt = (d: { isZero(): boolean; toFixed(n: number): string }) => (d.isZero() ? "" : d.toFixed(2));
  return (
    <>
      <div className="top"><h1>Edit draft {e.number}</h1></div>
      <JournalForm {...data} canPost={can(ctx.role, "journal.post")} initial={{
        id: e.id, date: fmtDate(e.date), transactionDate: fmtDate(e.transactionDate), memo: e.memo, reference: e.reference ?? "",
        currencyCode: e.lines[0]?.currencyCode ?? data.baseCurrency, fxRate: e.lines[0]?.fxRate.toString() ?? "1",
        lines: e.lines.map((l) => ({
          accountId: l.accountId, description: l.description ?? "", debit: amt(l.fxDebit), credit: amt(l.fxCredit),
          dims: Object.fromEntries(DIM_KEYS.map((k) => [k, l[k] ?? ""])),
        })),
        attachments: e.attachments.map((a) => ({ name: a.name, url: a.url })),
      }} />
    </>
  );
}
