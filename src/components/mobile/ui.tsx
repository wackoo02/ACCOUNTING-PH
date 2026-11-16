"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";

export function Header({ title, sub, onBack, icon, right }: { title: string; sub?: string; onBack?: () => void; icon?: IconName; right?: ReactNode }) {
  return (
    <header className="vm-head">
      {onBack ? <button className="vm-iconbtn" onClick={onBack} aria-label="Back"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg></button> : <span style={{ width: 8 }} />}
      {icon && <span className="vm-head-ic"><Icon name={icon} size={20} /></span>}
      <div className="vm-head-t"><div className="t">{title}</div>{sub && <div className="s">{sub}</div>}</div>
      <div className="vm-head-r">{right}</div>
    </header>
  );
}

export function Tile({ icon, label, blurb, onClick, delay = 0, badge, tone = "purple" }: { icon: IconName; label: string; blurb?: string; onClick: () => void; delay?: number; badge?: number; tone?: "purple" | "orange" | "ink" | "teal" | "rose" | "sky" }) {
  return (
    <button className={`vm-tile tone-${tone}`} style={{ animationDelay: `${delay}ms` }} onClick={onClick}>
      <span className="vm-tile-ic"><span className="glow" /><Icon name={icon} size={30} /></span>
      <span className="vm-tile-l">{label}</span>
      {blurb && <span className="vm-tile-b">{blurb}</span>}
      {!!badge && <span className="vm-badge">{badge}</span>}
    </button>
  );
}

const STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "grey" }, SUBMITTED: { label: "With manager", tone: "blue" }, APPROVED: { label: "Finance review", tone: "violet" },
  RETURNED: { label: "Returned", tone: "amber" }, REJECTED: { label: "Rejected", tone: "red" }, CLEARED: { label: "Cleared", tone: "green" },
  HOLD: { label: "On hold", tone: "amber" }, BATCHED: { label: "In replenishment", tone: "violet" }, REPLENISHED: { label: "Replenished", tone: "green" },
  REIMBURSED: { label: "Reimbursed", tone: "green" }, OPEN: { label: "Open", tone: "blue" }, CLOSED: { label: "Closed", tone: "grey" },
  FOUND: { label: "Found", tone: "green" }, WRONG_LOCATION: { label: "Wrong location", tone: "amber" }, UNKNOWN: { label: "Unknown tag", tone: "red" },
  PENDING_APPROVAL: { label: "For approval", tone: "blue" }, POSTED: { label: "Posted", tone: "green" },
};
export const statusLabel = (s: string) => STATUS[s]?.label ?? s;
export function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "grey" };
  return <span className={`vm-pill ${s.tone}`}>{s.label}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <div className="vm-spin"><span className="ring" />{label && <span>{label}</span>}</div>;
}

export function Errors({ errors }: { errors?: string[] | null }) {
  if (!errors?.length) return null;
  return <div className="vm-errors" role="alert">{errors.map((e, i) => <div key={i}>{e}</div>)}</div>;
}
export function Warnings({ items }: { items?: string[] | null }) {
  if (!items?.length) return null;
  return <div className="vm-warn">{items.map((e, i) => <div key={i}>{e}</div>)}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="vm-field"><span className="l">{label}</span>{children}{hint && <span className="h">{hint}</span>}</label>;
}

export function Chips<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T | null | undefined; onChange: (v: T) => void }) {
  return (
    <div className="vm-chips">
      {options.map((o) => <button type="button" key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="vm-sheet-bg" onClick={onClose}>
      <div className="vm-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="vm-sheet-t">{title}</div>
        {children}
      </div>
    </div>
  );
}

let toastFn: (t: { text: string; tone?: "ok" | "err" | "info" }) => void = () => {};
export const toast = (text: string, tone: "ok" | "err" | "info" = "ok") => toastFn({ text, tone });
export function Toaster() {
  const [t, setT] = useState<{ text: string; tone?: string; k: number } | null>(null);
  useEffect(() => { toastFn = (x) => setT({ ...x, k: Date.now() }); }, []);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), 2600); return () => clearTimeout(h); }, [t]);
  return t ? <div key={t.k} className={`vm-toast ${t.tone}`}>{t.text}</div> : null;
}

/** Big animated tick (or cross) for "submitted" / "cleared" moments. */
export function Burst({ ok = true, title, sub, children }: { ok?: boolean; title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="vm-burst">
      <svg viewBox="0 0 80 80" className={ok ? "ok" : "bad"}>
        <circle cx="40" cy="40" r="34" className="c" />
        {ok ? <path d="M25 41l10 10 20-22" className="k" /> : <path d="M28 28l24 24M52 28L28 52" className="k" />}
      </svg>
      <div className="t">{title}</div>
      {sub && <div className="s">{sub}</div>}
      {children}
    </div>
  );
}

/** Counts up to a peso amount (respects reduced motion). */
export function CountUp({ value, prefix = "₱" }: { value: number; prefix?: string }) {
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setV(value); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      setV(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <>{prefix}{v.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>;
}

export function Empty({ icon, text }: { icon: IconName; text: string }) {
  return <div className="vm-empty"><span className="ic"><Icon name={icon} size={34} /></span><div>{text}</div></div>;
}
