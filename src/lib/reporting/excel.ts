// Excel download of any report result, keeping the multi-level column headers and subtotals.
import ExcelJS from "exceljs";
import type { ReportResult } from "./result";

export function headerLevels(r: ReportResult) {
  return Math.max(1, ...r.columns.map((c) => c.head.length));
}

export async function resultWorkbook(r: ReportResult) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report", { views: [{ state: "frozen", ySplit: 3 + headerLevels(r), xSplit: r.labelHead !== null ? 1 : 0 }] });
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([r.subtitle]).font = { color: { argb: "FF5F6B7A" } };
  ws.addRow([]);
  const levels = headerLevels(r);
  const off = r.labelHead !== null ? 1 : 0;
  const headStart = ws.rowCount + 1;
  for (let L = 0; L < levels; L++) {
    const vals: (string | null)[] = [];
    if (off) vals.push(L === 0 ? r.labelHead || "" : null);
    for (const c of r.columns) vals.push(L < c.head.length ? c.head[L] : null);
    const row = ws.addRow(vals);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6D28D9" } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
  }
  // Merge repeated group headings across columns.
  for (let L = 0; L < levels - 1; L++) {
    let start = 0;
    for (let i = 1; i <= r.columns.length; i++) {
      const same = i < r.columns.length && r.columns[i].head.length > L + 1 && r.columns[start].head.length > L + 1 && r.columns[i].head.slice(0, L + 1).join("\u0001") === r.columns[start].head.slice(0, L + 1).join("\u0001");
      if (!same) { if (i - 1 > start) ws.mergeCells(headStart + L, start + 1 + off, headStart + L, i + off); start = i; }
    }
  }
  for (const row of r.rows) {
    const vals: (string | number | null)[] = [];
    if (off) vals.push(`${"   ".repeat(row.depth)}${row.label}`);
    r.columns.forEach((c, i) => {
      const v = row.cells[i];
      if (v === null || v === undefined) { vals.push(null); return; }
      if (c.kind === "amount") vals.push(Number(BigInt(v as string)) / 100);
      else if (c.kind === "pct") vals.push(typeof v === "number" ? v / 100 : null);
      else if (c.kind === "number") vals.push(Number(v));
      else vals.push(String(v));
    });
    if (!off && row.label && vals[0] === null) vals[0] = row.label;
    const xr = ws.addRow(vals);
    if (row.kind === "header" || row.kind === "subtotal" || row.kind === "total") xr.font = { bold: true };
    if (row.kind === "total") xr.eachCell((cell) => { cell.border = { top: { style: "thin" }, bottom: { style: "double" } }; });
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1 + off);
    col.width = c.kind === "text" ? 28 : c.kind === "date" ? 12 : 16;
    if (c.kind === "amount") col.numFmt = "#,##0.00;(#,##0.00);-";
    if (c.kind === "pct") col.numFmt = "0.0%";
  });
  if (off) ws.getColumn(1).width = 44;
  if (r.notes.length) { ws.addRow([]); for (const n of r.notes) ws.addRow([n]).font = { italic: true, color: { argb: "FF5F6B7A" } }; }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
