import Link from "next/link";
import { FORMS, type FormCode } from "@/lib/tax/periods";

export const TAX_TABS = [
  { href: "/tax", label: "Overview" },
  { href: "/tax/review", label: "Tax review" },
  { href: "/tax/lists/slsp", label: "SLSP (RELIEF)" },
  { href: "/tax/lists/qap", label: "QAP" },
  { href: "/tax/lists/sawt", label: "SAWT" },
  { href: "/tax/2307", label: "BIR 2307" },
  { href: "/tax/alphalist", label: "Alphalists" },
  { href: "/tax/books", label: "Books of accounts" },
];

export function TaxTabs({ active }: { active: string }) {
  return (
    <div className="noprint tax-tabs">
      {TAX_TABS.map((t) => <Link key={t.href} href={t.href} className={t.href === active ? "on" : undefined}>{t.label}</Link>)}
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Year + quarter (or month) picker as a GET form. */
export function PeriodPicker({ year, n, freq, extra }: { year: number; n: number; freq: "Q" | "M" | "Y"; extra?: React.ReactNode }) {
  const years = Array.from({ length: 6 }, (_, i) => new Date().getUTCFullYear() + 1 - i);
  return (
    <form className="card row noprint">
      <div style={{ maxWidth: 120 }}><label>Year</label><select name="year" defaultValue={year}>{years.map((y) => <option key={y}>{y}</option>)}</select></div>
      {freq === "Q" && <div style={{ maxWidth: 140 }}><label>Quarter</label><select name="n" defaultValue={n}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</select></div>}
      {freq === "M" && <div style={{ maxWidth: 140 }}><label>Month</label><select name="n" defaultValue={n}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>}
      {extra}
      <div style={{ flex: 0 }}><button>Show</button></div>
    </form>
  );
}

export function currentQuarter() {
  const d = new Date();
  return { year: d.getUTCFullYear(), q: Math.floor(d.getUTCMonth() / 3) + 1, m: d.getUTCMonth() + 1 };
}

export function num(v: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export const formLabel = (f: FormCode) => `${f.replace(/^(\d{4})([A-Z]{1,2})$/, "$1-$2").replace("2550-Q", "2550Q").replace("2550-M", "2550M").replace("2551-Q", "2551Q")} · ${FORMS[f].name}`;
