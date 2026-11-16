import Link from "next/link";
import type { Cell, Column, ReportResult, Row } from "@/lib/reporting/result";
import { formatPeso } from "@/lib/money";

/** Renders any report result: multi-level column headers, indented rows, subtotals and totals. */
export function ReportTable({ r }: { r: ReportResult }) {
  const levels = Math.max(1, ...r.columns.map((c) => c.head.length));
  const hasLabel = r.labelHead !== null;
  return (
    <div className="table-wrap report-table">
      <table>
        <thead>
          {Array.from({ length: levels }, (_, L) => (
            <tr key={L}>
              {hasLabel && L === 0 && <th rowSpan={levels}>{r.labelHead}</th>}
              {headerCells(r.columns, L, levels)}
            </tr>
          ))}
        </thead>
        <tbody>
          {r.rows.map((row) => <ReportRow key={row.key} row={row} cols={r.columns} hasLabel={hasLabel} />)}
          {r.rows.length === 0 && <tr><td colSpan={r.columns.length + (hasLabel ? 1 : 0)} className="muted">Nothing to show.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function headerCells(cols: Column[], L: number, levels: number) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < cols.length) {
    const c = cols[i];
    if (c.head.length <= L) { i++; continue; } // covered by a taller cell above
    const last = c.head.length - 1 === L;
    let j = i + 1;
    if (!last) {
      const key = c.head.slice(0, L + 1).join("\u0001");
      while (j < cols.length && cols[j].head.length > L + 1 && cols[j].head.slice(0, L + 1).join("\u0001") === key) j++;
    }
    const numeric = c.kind === "amount" || c.kind === "pct" || c.kind === "number";
    out.push(<th key={`${L}:${i}`} colSpan={j - i} rowSpan={last ? levels - L : 1} className={last && numeric ? "num" : "grp"}>{c.head[L]}</th>);
    i = j;
  }
  return out;
}

export function fmtCell(v: Cell, c: Column): string {
  if (v === null || v === undefined) return "";
  if (c.kind === "amount") return formatPeso(BigInt(v as string));
  if (c.kind === "pct") return typeof v === "number" ? `${v.toFixed(1)}%` : "";
  return String(v);
}

function ReportRow({ row, cols, hasLabel }: { row: Row; cols: Column[]; hasLabel: boolean }) {
  const cls = row.kind === "total" ? "total" : row.kind === "header" || row.kind === "subtotal" ? "header" : row.kind === "detail" ? "muted" : "";
  if (row.kind === "spacer") return <tr className="spacer"><td colSpan={cols.length + (hasLabel ? 1 : 0)}>&nbsp;</td></tr>;
  const pad = { paddingLeft: 8 + row.depth * 18 };
  if (hasLabel) {
    return (
      <tr className={cls}>
        <td style={pad}>{row.link ? <Link href={row.link}>{row.label}</Link> : row.label}</td>
        {cols.map((c, i) => <td key={c.key} className={c.kind === "text" ? "" : c.kind === "date" ? "nowrap" : "num"}>{fmtCell(row.cells[i], c)}</td>)}
      </tr>
    );
  }
  // Listing rows: a header/subtotal label takes the empty cells before the first value.
  let lead = 0;
  if (row.label) { while (lead < cols.length && (row.cells[lead] === null || row.cells[lead] === undefined)) lead++; }
  if (row.label && lead === cols.length) return <tr className={cls}><td colSpan={cols.length} style={pad}>{row.label}</td></tr>;
  const linkIdx = row.link ? cols.findIndex((c, i) => c.kind === "text" && row.cells[i]) : -1;
  return (
    <tr className={cls}>
      {lead > 0 && <td colSpan={lead} style={pad}>{row.label}</td>}
      {cols.slice(lead).map((c, k) => {
        const i = k + lead;
        const txt = fmtCell(row.cells[i], c);
        return <td key={c.key} className={c.kind === "amount" || c.kind === "pct" || c.kind === "number" ? "num" : c.kind === "date" ? "nowrap" : ""} style={k === 0 && lead === 0 && row.depth ? pad : undefined}>
          {i === linkIdx ? <Link href={row.link!}>{txt}</Link> : txt}
        </td>;
      })}
    </tr>
  );
}
