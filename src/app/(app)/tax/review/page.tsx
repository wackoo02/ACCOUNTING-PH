import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, fromCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { taxLines, tieOut } from "@/lib/tax/ledger";
import { quarter } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { CLASS_LABEL, KIND_LABEL, PURCHASE_CLASSES, SALES_CLASSES } from "@/lib/tax/types";
import { ActionForm } from "@/components/ActionForm";
import { classifyAction, unclassifyAction } from "../../tax-actions";
import { PeriodPicker, TaxTabs, currentQuarter, num } from "../ui";

export default async function TaxReview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const cur = currentQuarter();
  const year = num(sp.year, cur.year, 2000, 2100);
  const n = num(sp.n, cur.q, 1, 4);
  const p = quarter(year, n);
  const t = await tieOut(ctx.org.id, p.from, p.to);
  const lines = await taxLines(ctx.org.id, p.from, p.to);
  const edit = can(ctx.role, "period.close");
  const [vendors, customers, codes] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { name: "asc" }, select: { code: true, name: true } }),
    prisma.customer.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { name: "asc" }, select: { code: true, name: true } }),
    prisma.taxCode.findMany({ where: { organizationId: ctx.org.id, isActive: true, atcCode: { not: null } }, orderBy: { code: "asc" } }),
  ]);
  return (
    <>
      <div className="top"><h1>Tax review</h1><span className="muted">{p.label}</span></div>
      <TaxTabs active="/tax/review" />
      <PeriodPicker year={year} n={n} freq="Q" />
      <p className="muted">
        Returns are built from the tax details each module records (sales, purchases, cash vouchers, petty cash, payroll). A manual journal or a cash voucher line that posts straight to a tax account has no
        details yet: say what it is below so it reaches the right return, or mark it as not a tax transaction (opening balances, corrections).
      </p>
      <h2>GL tax lines without tax details ({t.unexplained.length})</h2>
      {t.unexplained.map((u) => {
        const vat = u.kind === "OUTPUT_VAT" || u.kind === "INPUT_VAT";
        const classes = u.kind === "OUTPUT_VAT" ? SALES_CLASSES : PURCHASE_CLASSES;
        const parties = u.kind === "OUTPUT_VAT" || u.kind === "CWT" || u.kind === "VAT_WITHHELD" ? customers.map((c) => ({ v: `CUSTOMER:${c.code}`, l: c.name })) : vendors.map((v) => ({ v: `VENDOR:${v.code}`, l: v.name }));
        const defParty = u.partyType && u.partyId ? `${u.partyType}:${u.partyId}` : "";
        const rate = vat && u.suggestedBase > 0n ? "12" : "";
        return (
          <div key={u.lineId} className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <div><label>Entry</label><Link href={`/journals/${u.entryId}`}>{u.number}</Link> · {fmtDate(u.date)}</div>
              <div style={{ flex: 2 }}><label>Particulars</label>{u.memo} {u.reference && <span className="muted">· {u.reference}</span>}</div>
              <div><label>Account</label>{u.accountCode} · {u.accountName}</div>
              <div><label>Amount</label><b>{formatPeso(u.amount)}</b></div>
            </div>
            {edit && (
              <ActionForm action={classifyAction}>
                <input type="hidden" name="lineId" value={u.lineId} />
                <div className="row">
                  <div><label>This is</label><select name="kind" defaultValue={u.kind}>
                    <option value={u.kind}>{KIND_LABEL[u.kind]}</option><option value="EXCLUDED">{KIND_LABEL.EXCLUDED}</option></select></div>
                  {vat && <div><label>Classification</label><select name="vatClass" defaultValue={u.kind === "OUTPUT_VAT" ? "VATABLE" : "GOODS"}>{classes.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}</select></div>}
                  {!vat && <div><label>ATC</label><select name="atcCode" defaultValue="">{codes.map((c) => <option key={c.id} value={c.atcCode!}>{c.atcCode} · {c.name}</option>)}</select></div>}
                  <div><label>Tax base (net of VAT)</label><input name="taxBase" className="num" defaultValue={fromCentavos(u.suggestedBase)} /></div>
                  <div style={{ maxWidth: 90 }}><label>Rate %</label><input name="rate" className="num" defaultValue={rate} /></div>
                  <div><label>Tax</label><input name="taxAmount" className="num" defaultValue={fromCentavos(u.amount)} /></div>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <div><label>Customer / supplier</label><select name="party" defaultValue={defParty}><option value="">Other (type below)</option>{parties.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}</select></div>
                  <div><label>or name</label><input name="partyName" /></div>
                  <div><label>TIN</label><input name="partyTin" placeholder="000-000-000-00000" /></div>
                  <div><label>Invoice no.</label><input name="docNumber" defaultValue={u.reference ?? ""} /></div>
                  <div style={{ flex: 0 }}><button>Save</button></div>
                </div>
              </ActionForm>
            )}
          </div>
        );
      })}
      {t.unexplained.length === 0 && <p className="muted">Nothing to classify for {p.label}.</p>}

      <h2>Tax ledger ({lines.length} lines)</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Class / ATC</th><th>From</th><th>Document</th><th>Party</th><th>TIN</th><th className="num">Base</th><th className="num">Tax</th><th></th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td>{fmtDate(l.date)}</td><td>{KIND_LABEL[l.kind]}</td><td>{l.vatClass ? CLASS_LABEL[l.vatClass] ?? l.vatClass : l.atcCode}</td>
              <td>{l.journalEntryId ? <Link href={`/journals/${l.journalEntryId}`}>{l.journalNumber}</Link> : l.source}</td>
              <td>{[l.docType, l.docNumber].filter(Boolean).join(" ")}</td><td>{l.party.name}</td><td>{formatTin(l.party.tin) || <span className="diff-bad">none</span>}</td>
              <td className="num">{formatPeso(l.base)}</td><td className="num">{formatPeso(l.tax)}</td>
              <td>{edit && l.source === "MANUAL" && l.journalLineId && <ActionForm action={unclassifyAction}><input type="hidden" name="lineId" value={l.journalLineId} /><button className="link">Undo</button></ActionForm>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}
