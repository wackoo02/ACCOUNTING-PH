import Link from "next/link";
import { Fragment } from "react";
import { formatPeso } from "@/lib/money";
import type { StatementSection } from "@/lib/ledger/reports";

export function SectionRows({ s, detail, sign = 1n, ledgerQs = "" }: { s: StatementSection; detail?: boolean; sign?: bigint; ledgerQs?: string }) {
  return (
    <>
      <tr className="header"><td colSpan={2}>{s.title}</td></tr>
      {s.lines.map((l) => (
        <Fragment key={l.label}>
          <tr><td style={{ paddingLeft: 20 }}>{l.label}</td><td className="num">{formatPeso(sign * l.amount)}</td></tr>
          {detail && l.accounts?.map((a) => (
            <tr key={a.id} className="muted"><td style={{ paddingLeft: 40 }}><Link href={`/ledger?account=${a.id}${ledgerQs}`}>{a.code} {a.name}</Link></td><td className="num">{formatPeso(sign * a.amount)}</td></tr>
          ))}
        </Fragment>
      ))}
      {s.lines.length === 0 && <tr><td style={{ paddingLeft: 20 }} className="muted">—</td><td /></tr>}
      <tr><td style={{ paddingLeft: 20 }}><b>Total {s.title.toLowerCase()}</b></td><td className="num"><b>{formatPeso(sign * s.total)}</b></td></tr>
    </>
  );
}

export function TotalRow({ label, amount, strong }: { label: string; amount: bigint; strong?: boolean }) {
  return <tr className={strong ? "total" : "header"}><td>{label}</td><td className="num">{formatPeso(amount)}</td></tr>;
}
