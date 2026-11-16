import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { today } from "@/lib/format";
import { cashFormData } from "@/lib/bank/form-data";
import { CashForm, type CashMode } from "@/components/CashForm";

const TITLES: Record<CashMode, string> = { RECEIPT: "New Cash Receipt", DISBURSEMENT: "New Disbursement (Cash or Check Voucher)", PETTY: "New Petty Cash Voucher", TRANSFER: "New Fund Transfer" };

export default async function NewCash({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const ctx = await requireCtx("journal.create");
  const sp = await searchParams;
  const mode = (["RECEIPT", "DISBURSEMENT", "PETTY", "TRANSFER"].includes(sp.type ?? "") ? sp.type : "DISBURSEMENT") as CashMode;
  const data = await cashFormData(ctx.org.id);
  const first = data.banks.find((b) => (mode === "PETTY" ? b.kind === "PETTY_CASH" : b.kind === "CURRENT" || b.kind === "SAVINGS"));
  return (
    <>
      <div className="top"><h1>{TITLES[mode]}</h1></div>
      {mode === "PETTY" && !first && <div className="notice">Add a petty cash fund (kind PETTY_CASH) under Master Lists → Bank and Cash Accounts first.</div>}
      <CashForm {...data} mode={mode} canPost={can(ctx.role, "journal.post")} initial={{
        bankAccountId: first?.id ?? "", toBankAccountId: "", date: today(), payee: "", party: "", method: mode === "PETTY" ? "CASH" : mode === "DISBURSEMENT" && first?.nextCheckNo ? "CHECK" : "BANK_TRANSFER",
        checkNo: "", checkDate: "", reference: "", memo: "", fxRate: first && first.currencyCode !== data.baseCurrency ? data.currencies.find((c) => c.code === first.currencyCode)?.rate ?? "" : "1",
        amount: "", toAmount: "", toFxRate: "1", withholdingTaxCodeId: "", withholdingAmount: "", lines: [],
      }} />
    </>
  );
}
