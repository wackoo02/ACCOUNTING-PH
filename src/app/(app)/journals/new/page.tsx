import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { JournalForm } from "@/components/JournalForm";
import { journalFormData } from "@/lib/journal-form-data";
import { today } from "@/lib/format";

export default async function NewJournal() {
  const ctx = await requireCtx("journal.create");
  const data = await journalFormData(ctx.org.id);
  return (
    <>
      <div className="top"><h1>New Journal Entry</h1></div>
      <JournalForm {...data} canPost={can(ctx.role, "journal.post")}
        initial={{ date: today(), transactionDate: today(), memo: "", reference: "", currencyCode: data.baseCurrency, fxRate: "1", lines: [], attachments: [] }} />
    </>
  );
}
