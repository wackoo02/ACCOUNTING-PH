import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, fromCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { computeReturn } from "@/lib/tax/returns";
import { FORMS, dueDate, isForm } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { KIND_LABEL, CLASS_LABEL } from "@/lib/tax/types";
import { ActionForm } from "@/components/ActionForm";
import { PrintButton } from "@/components/PrintButton";
import { fileReturnAction, reopenReturnAction, saveReturnAction } from "../../../tax-actions";
import { PeriodPicker, TaxTabs, currentQuarter, num } from "../../ui";

const ATTACH: Record<string, { label: string; href: (y: number, n: number) => string }[]> = {
  "2550Q": [{ label: "SLSP (RELIEF)", href: (y, n) => `/tax/lists/slsp?year=${y}&n=${n}` }, { label: "SAWT (VAT withheld)", href: (y, n) => `/tax/lists/sawt?year=${y}&n=${n}&form=2550Q` }],
  "2551Q": [{ label: "SAWT (percentage tax withheld)", href: (y, n) => `/tax/lists/sawt?year=${y}&n=${n}&form=2551Q` }],
  "1601EQ": [{ label: "QAP", href: (y, n) => `/tax/lists/qap?year=${y}&n=${n}&form=1601EQ` }, { label: "BIR 2307 certificates", href: (y, n) => `/tax/2307?year=${y}&q=${n}` }],
  "1601FQ": [{ label: "QAP", href: (y, n) => `/tax/lists/qap?year=${y}&n=${n}&form=1601FQ` }],
};

export default async function ReturnPage({ params, searchParams }: { params: Promise<{ form: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { form } = await params;
  if (!isForm(form)) notFound();
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const cur = currentQuarter();
  const freq = FORMS[form].freq;
  const year = num(sp.year, cur.year, 2000, 2100);
  const n = num(sp.n, freq === "Q" ? cur.q : cur.m, 1, freq === "Q" ? 4 : 12);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const r = await computeReturn(org.id, form, year, n);
  const filed = r.saved?.status === "FILED";
  const editable = !filed && can(ctx.role, "period.close");
  const due = dueDate(form, r.period.to);
  const peso = (v?: bigint) => (v === undefined ? "" : formatPeso(v));
  return (
    <>
      <div className="top">
        <h1>BIR {form} · {FORMS[form].name}</h1>
        <div style={{ display: "flex", gap: 8 }} className="noprint">
          <a className="btn secondary" href={`/api/tax/return?form=${form}&year=${year}&n=${n}`}>Download CSV</a>
          <PrintButton />
        </div>
      </div>
      <TaxTabs active="" />
      <PeriodPicker year={year} n={n} freq={freq} />
      <div className="card">
        <div className="row">
          <div><label>Taxpayer</label>{org.name}</div>
          <div><label>TIN</label>{formatTin(org.tin) || <span className="diff-bad">not set</span>}</div>
          <div><label>RDO</label>{org.rdoCode ?? "—"}</div>
          <div><label>Period</label>{r.period.label} ({fmtDate(r.period.from)} to {fmtDate(r.period.to)})</div>
          <div><label>Due</label>{fmtDate(due)}</div>
          <div><label>Status</label>{filed ? <span className="badge FILED">Filed {r.saved?.filedAt ? fmtDate(r.saved.filedAt) : ""}</span> : <span className="badge DRAFT">Draft</span>}</div>
        </div>
        {form === "2550M" && <p className="muted">Monthly VAT declarations are optional from January 2023 (RMC 52-2023). The quarterly 2550Q is required either way; VAT paid here is credited there.</p>}
        {form === "2551Q" && org.vatRegistered && <p className="muted">This company is VAT-registered: 2551Q applies only to non-VAT taxpayers or to specific percentage taxes.</p>}
      </div>
      {r.warnings.map((w) => <div key={w} className="notice">{w}</div>)}

      <ActionForm action={saveReturnAction}>
        <input type="hidden" name="form" value={form} /><input type="hidden" name="year" value={year} /><input type="hidden" name="n" value={n} />
        {r.sections.map((s) => (
          <div key={s.title} style={{ marginBottom: 14 }}>
            <h2>{s.title}</h2>
            <div className="table-wrap"><table className="ret">
              <thead><tr><th>Item</th><th className="num">Amount / tax base</th><th className="num">Rate</th><th className="num">Tax</th></tr></thead>
              <tbody>
                {s.rows.map((row) => (
                  <tr key={row.key} className={row.strong ? "strong" : undefined}>
                    <td>{row.label}{row.note && <span className="muted"> · {row.note}</span>}</td>
                    <td className="num">{peso(row.base)}</td>
                    <td className="num">{row.rate ?? ""}</td>
                    <td className={`num${row.input && editable ? " in" : ""}`}>
                      {row.input && editable ? <input name={`in.${row.key}`} className="num" defaultValue={r.saved?.inputs[row.key] ?? (row.tax ? fromCentavos(row.tax) : "")} placeholder="0.00" /> : peso(row.tax)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        ))}
        {editable && <button className="noprint">Save draft and recompute</button>}
      </ActionForm>

      {ATTACH[form] && <p className="noprint"><b>Attachments:</b> {ATTACH[form].map((a, i) => <span key={a.label}>{i > 0 && " · "}<Link href={a.href(year, n)}>{a.label}</Link></span>)}</p>}

      {editable && (
        <ActionForm action={fileReturnAction} className="card noprint" confirm="Record this return as filed? The figures will be frozen.">
          <h2 style={{ marginTop: 0 }}>Record filing</h2>
          <p className="muted">After you file and pay through eFPS or eBIRForms, record it here. The figures above are saved with it.</p>
          <input type="hidden" name="form" value={form} /><input type="hidden" name="year" value={year} /><input type="hidden" name="n" value={n} />
          <div className="row">
            <div><label>Date filed</label><input type="date" name="filedAt" defaultValue={today()} required /></div>
            <div><label>Filing reference / confirmation no.</label><input name="filingRef" /></div>
            <div><label>Amount paid</label><input name="amountPaid" className="num" defaultValue={fromCentavos(r.taxDue)} /></div>
            <div><label>Payment reference (bank / ePay)</label><input name="paymentRef" /></div>
          </div>
          {form === "2550Q" && <label style={{ display: "flex", gap: 6, marginTop: 10, color: "var(--ink)" }}><input type="checkbox" name="postClosing" defaultChecked style={{ width: "auto" }} /> Post the VAT closing entry (output VAT less input VAT and VAT withheld, to VAT Payable) dated {fmtDate(r.period.to)}</label>}
          <button style={{ marginTop: 10 }}>Record as filed</button>
        </ActionForm>
      )}
      {filed && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Filing</h2>
          <div className="row">
            <div><label>Filed</label>{r.saved?.filedAt ? fmtDate(r.saved.filedAt) : ""}</div>
            <div><label>Reference</label>{r.saved?.filingRef ?? "—"}</div>
            <div><label>Amount paid</label>{formatPeso(r.saved?.amountPaid ?? 0n)}</div>
            <div><label>Payment reference</label>{r.saved?.paymentRef ?? "—"}</div>
            {r.saved?.journalEntryId && <div><label>VAT closing entry</label><Link href={`/journals/${r.saved.journalEntryId}`}>Open entry</Link></div>}
          </div>
          <p className="muted">Live figures are shown above. If they differ from what was filed (for example a late invoice), you may need an amended return.</p>
          {can(ctx.role, "org.manage") && (
            <ActionForm action={reopenReturnAction} confirm="Reopen this return? The filing record is cleared and any VAT closing entry is reversed.">
              <input type="hidden" name="id" value={r.saved?.id} /><button className="secondary noprint">Reopen</button>
            </ActionForm>
          )}
        </div>
      )}

      <h2>Transactions in this return</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Class / ATC</th><th>Document</th><th>Party</th><th>TIN</th><th>Entry</th><th className="num">Base</th><th className="num">Tax</th></tr></thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.key}>
              <td>{fmtDate(l.date)}</td><td>{KIND_LABEL[l.kind]}</td><td>{l.vatClass ? CLASS_LABEL[l.vatClass] ?? l.vatClass : l.atcCode}</td>
              <td>{[l.docType, l.docNumber].filter(Boolean).join(" ")}</td><td>{l.party.name}</td><td>{formatTin(l.party.tin)}</td>
              <td>{l.journalEntryId ? <Link href={`/journals/${l.journalEntryId}`}>{l.journalNumber}</Link> : ""}</td>
              <td className="num">{formatPeso(l.base)}</td><td className="num">{formatPeso(l.tax)}</td>
            </tr>
          ))}
          {r.lines.length === 0 && <tr><td colSpan={9} className="muted">No transactions in this period.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
