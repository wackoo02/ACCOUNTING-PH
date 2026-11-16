"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";
import type { VoucherOut } from "@/lib/pettycash/service";
import { ApiFail, api, fetchImage, peso } from "./api";
import { Burst, Empty, Errors, Header, Pill, Sheet, Spinner, toast } from "./ui";
import type { Me, ModuleKey, Nav, Setup } from "./App";

const ICON: Record<string, IconName> = { PETTY_CASH: "petty-cash", TRAVEL: "travel", TRANSPORT: "transport", DELIVERY: "sent-package" };
const LABEL: Record<string, string> = { PETTY_CASH: "Petty Cash", TRAVEL: "Travel", TRANSPORT: "Transport", DELIVERY: "Sent Package" };
const PAY: Record<string, string> = { PETTY_CASH_FUND: "Petty cash fund", EMPLOYEE: "Paid by employee", GCASH: "Corporate GCash", MAYA: "Corporate Maya", CREDIT_CARD: "Corporate credit card", DEBIT_CARD: "Corporate debit card", CORPORATE_WALLET: "Corporate wallet", COMPANY_ACCOUNT: "Company account" };
const total = (v: VoucherOut) => Number(v.grossAmount) + Number(v.tipAmount);
type Check = { key: string; label: string; ok: boolean; level: "info" | "warn" | "block"; note: string };

export function ClaimList({ queue, me, nav }: { queue: "mine" | "manager" | "finance"; me: Me; nav: Nav }) {
  const [rows, setRows] = useState<VoucherOut[] | null>(null);
  const [filter, setFilter] = useState("ALL");
  useEffect(() => {
    const q = queue === "mine" ? "vouchers?mine=1" : `vouchers?queue=${queue}`;
    api<VoucherOut[]>("GET", q).then(setRows).catch(() => setRows([]));
  }, [queue]);
  const title = queue === "mine" ? "My claims" : queue === "manager" ? "Manager approvals" : "Finance review";
  const shown = (rows ?? []).filter((r) => filter === "ALL" || (filter === "OPEN" ? ["DRAFT", "RETURNED", "SUBMITTED", "APPROVED", "HOLD"].includes(r.status) : r.status === filter));
  const sum = shown.reduce((s, r) => s + total(r), 0);
  return (
    <div className="vm-page">
      <Header title={title} sub={rows ? `${shown.length} · ${peso(sum)}` : undefined} icon={queue === "mine" ? "claims" : queue === "manager" ? "approvals" : "audit"} onBack={queue === "mine" ? undefined : nav.back} />
      {queue === "mine" && (
        <div className="vm-seg">
          {[["ALL", "All"], ["OPEN", "In progress"], ["RETURNED", "Returned"], ["CLEARED", "Cleared"]].map(([k, l]) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
      )}
      {!rows ? <Spinner /> : shown.length === 0 ? <Empty icon="claims" text={queue === "mine" ? "No claims yet. Tap the camera to capture a receipt." : "Nothing waiting. Nice."} /> : (
        <div className="vm-list stagger">
          {shown.map((v, i) => (
            <button key={v.id} className="vm-row claim" style={{ animationDelay: `${i * 35}ms` }} onClick={() => nav.go({ name: "claim", id: v.id, from: queue })}>
              <span className={`ic m-${v.module}`}><Icon name={ICON[v.module]} size={20} /></span>
              <span className="m">
                <b>{v.provider ? v.vendor.name : v.purpose || v.vendor.name}</b>
                <small>{v.number} · {v.receiptDate}{queue !== "mine" && v.employee ? ` · ${v.employee.name}` : ""}</small>
              </span>
              <span className="r"><b>{peso(total(v))}</b><Pill status={v.status} /></span>
            </button>
          ))}
        </div>
      )}
      {queue === "mine" && me.can.capture && <div style={{ height: 8 }} />}
    </div>
  );
}

const STEPS = [
  { key: "draft", label: "Captured" }, { key: "manager", label: "Manager" }, { key: "finance", label: "Finance" }, { key: "posted", label: "Posted" }, { key: "paid", label: "Paid" },
];
function stepOf(v: VoucherOut) {
  switch (v.status) {
    case "DRAFT": case "RETURNED": return 0;
    case "SUBMITTED": return 1;
    case "APPROVED": case "HOLD": return 2;
    case "CLEARED": return v.paymentMethod === "PETTY_CASH_FUND" ? 3 : v.paymentMethod === "EMPLOYEE" ? 3 : 4;
    case "BATCHED": return 3;
    case "REPLENISHED": case "REIMBURSED": return 4;
    default: return 0;
  }
}

export function ClaimDetail({ id, from, me, setup, nav }: { id: string; from: "mine" | "manager" | "finance"; me: Me; setup: Setup | null; nav: Nav }) {
  const [v, setV] = useState<VoucherOut | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [sheet, setSheet] = useState<null | "return" | "reject" | "hold" | "override">(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<VoucherOut>("GET", `vouchers/${id}`).then(async (x) => {
      setV(x);
      if (x.imageId) setImg(await fetchImage(x.imageId));
      if (me.can.finance && (x.status === "APPROVED" || x.status === "HOLD")) api<Check[]>("GET", `vouchers/${id}/checks`).then(setChecks).catch(() => {});
    }).catch((e) => setErrors(e instanceof ApiFail ? e.errors : ["Could not load"]));
  }, [id, me.can.finance]);

  const act = async (path: string, payload: unknown, msg: string) => {
    setBusy(true); setErrors([]);
    try {
      const r = await api<VoucherOut>("POST", `vouchers/${id}/${path}`, payload);
      setV(r); setSheet(null); setReason(""); setDone(msg); toast(msg);
    } catch (e) {
      setErrors(e instanceof ApiFail ? e.errors : ["Failed"]);
      setSheet(null);
    } finally { setBusy(false); }
  };

  if (!v) return <div className="vm-page"><Header title="Claim" onBack={nav.back} /><Errors errors={errors} />{!errors.length && <Spinner />}</div>;
  if (done && (from === "manager" || from === "finance")) {
    return <div className="vm-page"><Burst ok={!/reject/i.test(done)} title={done} sub={`${v.number} · ${peso(total(v))}`}><div className="vm-actions"><button className="vm-btn primary" onClick={nav.back}>Next claim</button></div></Burst></div>;
  }
  const det = (v.details ?? {}) as Record<string, unknown>;
  const mod = setup?.modules.find((m) => m.key === v.module);
  const step = stepOf(v);
  const mineEditable = (v.status === "DRAFT" || v.status === "RETURNED");
  const canManager = v.status === "SUBMITTED" && from !== "mine";
  const canFinance = me.can.finance && (v.status === "APPROVED" || v.status === "HOLD");
  const blocking = (checks ?? []).filter((c) => !c.ok && c.level === "block");
  const dupOnly = blocking.length > 0 && blocking.every((c) => c.key.startsWith("duplicate"));
  const mgrChecks = ((v.checks as { manager?: Check[] } | null)?.manager) ?? [];

  return (
    <div className="vm-page">
      <Header title={v.number} sub={LABEL[v.module]} icon={ICON[v.module]} onBack={nav.back} right={<Pill status={v.status} />} />
      <Errors errors={errors} />
      <div className="vm-amount-hero">
        <div className="l">{v.provider ? v.vendor.name : v.vendor.name}</div>
        <div className="n">{peso(total(v))}</div>
        <div className="s">{v.receiptDate} · {PAY[v.paymentMethod]}{v.paymentAccount ? ` · ${v.paymentAccount.name}` : ""}</div>
        {v.foreignTotal && <div className="s">{v.currencyCode} {Number(v.foreignTotal).toLocaleString()} @ {Number(v.fxRate)}</div>}
      </div>
      <div className="vm-steps">
        {STEPS.filter((s) => s.key !== "paid" || v.paymentMethod === "EMPLOYEE" || v.paymentMethod === "PETTY_CASH_FUND").map((s, i) => (
          <div key={s.key} className={`st ${i < step ? "done" : i === step ? "now" : ""} ${v.status === "REJECTED" && i === step ? "bad" : ""}`}><i />{s.label}</div>
        ))}
      </div>
      {v.rejectedReason && (v.status === "RETURNED" || v.status === "REJECTED") && <div className={`vm-note ${v.status === "REJECTED" ? "bad" : ""}`}><b>{v.status === "REJECTED" ? "Rejected" : "Returned"}:</b> {v.rejectedReason}</div>}
      {v.status === "HOLD" && v.financeNote && <div className="vm-note"><b>On hold:</b> {v.financeNote}</div>}

      <div className="vm-card">
        <dl className="vm-dl">
          {v.employee && <><dt>Employee</dt><dd>{v.employee.name} ({v.employee.code})</dd></>}
          {v.purpose && <><dt>Purpose</dt><dd>{v.purpose}</dd></>}
          {v.bookingNumber && <><dt>Booking no.</dt><dd>{v.bookingNumber}</dd></>}
          {v.tripAt && <><dt>When</dt><dd>{new Date(v.tripAt).toLocaleString("en-PH")}</dd></>}
          {mod?.detailFields.map((f) => det[f.key] ? <span key={f.key} style={{ display: "contents" }}><dt>{f.label}</dt><dd>{String(det[f.key])}</dd></span> : null)}
          <dt>Receipt</dt><dd>{v.noReceipt ? `None (${v.noReceiptReason})` : `${v.docType} ${v.docNumber ?? ""}`}</dd>
          <dt>Supplier TIN</dt><dd>{v.vendor.tin || "None"} · {v.vendor.vatRegistered ? "VAT" : "Non-VAT"}</dd>
          {Number(v.vatAmount) > 0 && <><dt>Input VAT</dt><dd>{peso(v.vatAmount)}</dd></>}
          {v.journal && <><dt>Journal</dt><dd>{v.journal.number} <Pill status={v.journal.status} /></dd></>}
          {v.approvedBy && <><dt>Manager</dt><dd>{v.approvedBy}</dd></>}
          {v.financeBy && <><dt>Finance</dt><dd>{v.financeBy}</dd></>}
        </dl>
        <div className="vm-lines">{v.lines.map((l) => <div key={l.lineNo}><span>{l.description}</span><b>{peso(l.amount)}</b></div>)}{Number(v.tipAmount) > 0 && <div><span>Tip</span><b>{peso(v.tipAmount)}</b></div>}</div>
      </div>
      {img && <div className="vm-thumb big"><img src={img} alt="Receipt" /></div>}

      {mgrChecks.length > 0 && <CheckList title="Manager checks" checks={mgrChecks} />}
      {checks && <CheckList title="Finance checks" checks={checks} />}

      {mineEditable && from === "mine" && (
        <div className="vm-sticky">
          <button className="vm-btn primary block" onClick={() => nav.go({ name: "capture", module: v.module as ModuleKey, id: v.id })}>{v.status === "RETURNED" ? "Fix and resubmit" : "Edit and submit"}</button>
        </div>
      )}
      {canManager && (
        <div className="vm-sticky">
          <button className="vm-btn ghost" onClick={() => setSheet("return")}>Return</button>
          <button className="vm-btn danger" onClick={() => setSheet("reject")}>Reject</button>
          <button className="vm-btn primary" disabled={busy} onClick={() => act("approve", {}, "Approved")}>Approve</button>
        </div>
      )}
      {canFinance && (
        <div className="vm-sticky">
          <button className="vm-btn ghost" onClick={() => setSheet(v.status === "HOLD" ? "return" : "hold")}>{v.status === "HOLD" ? "Return" : "Hold"}</button>
          <button className="vm-btn danger" onClick={() => setSheet("reject")}>Reject</button>
          <button className="vm-btn primary" disabled={busy || (blocking.length > 0 && !dupOnly)} onClick={() => (dupOnly ? setSheet("override") : act("clear", {}, v.paymentMethod === "PETTY_CASH_FUND" ? "Cleared for replenishment" : "Cleared and posted"))}>Clear</button>
        </div>
      )}
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title={sheet === "return" ? "Return to employee" : sheet === "reject" ? "Reject claim" : sheet === "hold" ? "Put on hold" : "Not a duplicate?"}>
        <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={sheet === "override" ? "Why this is not a duplicate" : "Reason the employee will see"} />
        <button className={`vm-btn block ${sheet === "reject" ? "danger" : "primary"}`} disabled={busy || !reason.trim()} onClick={() => {
          if (sheet === "override") act("clear", { note: reason, overrideDuplicates: true }, "Cleared and posted");
          else act(sheet!, { reason }, sheet === "return" ? "Returned" : sheet === "reject" ? "Rejected" : "On hold");
        }}>{sheet === "override" ? "Clear anyway" : "Confirm"}</button>
      </Sheet>
    </div>
  );
}

function CheckList({ title, checks }: { title: string; checks: Check[] }) {
  return (
    <div className="vm-card">
      <div className="vm-section-t">{title}</div>
      <div className="vm-checks">
        {checks.map((c, i) => (
          <div key={c.key + i} className={`ck ${c.ok ? "ok" : c.level}`} style={{ animationDelay: `${i * 60}ms` }}>
            <span className="b">{c.ok ? "✓" : c.level === "block" ? "!" : c.level === "warn" ? "•" : "i"}</span>
            <span><b>{c.label}</b><small>{c.note}</small></span>
          </div>
        ))}
      </div>
    </div>
  );
}
