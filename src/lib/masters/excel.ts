// Excel template download, export of current data, and parsing of uploads.
import ExcelJS from "exceljs";
import { MASTERS, type MasterKind } from "./config";
import { parseRow } from "./rows";

export async function buildWorkbook(kind: MasterKind, records: Record<string, unknown>[] = []) {
  const def = MASTERS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = "PH Accounting";
  const ws = wb.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = def.fields.map((f) => ({ header: f.required ? `${f.header} *` : f.header, key: f.key, width: Math.max(14, f.header.length + 4) }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F2540" } };

  for (const r of records) {
    ws.addRow(def.fields.map((f) => {
      const v = r[f.key];
      if (v === null || v === undefined) return "";
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "object") return Number(String(v)); // Prisma Decimal
      return v as string | number | boolean;
    }));
  }

  // Dropdowns for enum and TRUE/FALSE columns on the first 2,000 rows.
  def.fields.forEach((f, i) => {
    const list = f.type === "enum" ? f.options! : f.type === "bool" ? ["TRUE", "FALSE"] : null;
    if (!list) return;
    const col = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= 2001; r++) {
      ws.getCell(`${col}${r}`).dataValidation = { type: "list", allowBlank: !f.required, formulae: [`"${list.join(",")}"`] };
    }
  });

  const info = wb.addWorksheet("Instructions");
  info.columns = [
    { header: "Column", key: "c", width: 30 },
    { header: "Required", key: "r", width: 10 },
    { header: "Allowed values / format", key: "a", width: 45 },
    { header: "Example", key: "e", width: 28 },
    { header: "Notes", key: "n", width: 60 },
  ];
  info.getRow(1).font = { bold: true };
  for (const f of def.fields) {
    info.addRow({
      c: f.header,
      r: f.required ? "Yes" : "",
      a: f.type === "enum" ? f.options!.join(", ") : f.type === "bool" ? "TRUE / FALSE" : f.type === "date" ? "YYYY-MM-DD" : f.type === "number" ? "Number" : f.type === "int" ? "Whole number" : "Text",
      e: f.example === undefined ? "" : String(f.example),
      n: f.help ?? "",
    });
  }
  info.addRow({});
  info.addRow({ c: "How to use: fill in the Data sheet, one row per record, then upload it." });
  info.addRow({ c: "Rows whose code already exists are updated; new codes are added. Nothing is deleted." });
  info.addRow({ c: "If any row has an error, nothing is saved and every error is listed so you can fix them." });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type ParsedUpload = { rows: Record<string, unknown>[]; errors: string[] };

export async function parseUpload(kind: MasterKind, buf: ArrayBuffer): Promise<ParsedUpload> {
  const def = MASTERS[kind];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    return { rows: [], errors: ["The file could not be read. Please upload the .xlsx template."] };
  }
  const ws = wb.getWorksheet("Data") ?? wb.worksheets[0];
  if (!ws) return { rows: [], errors: ["The workbook has no sheets"] };

  const norm = (s: string) => s.replace(/\*/g, "").trim().toLowerCase();
  const colByKey = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const h = norm(String(cell.value ?? ""));
    const f = def.fields.find((x) => norm(x.header) === h || x.key.toLowerCase() === h);
    if (f) colByKey.set(f.key, col);
  });
  const missing = def.fields.filter((f) => f.required && !colByKey.has(f.key)).map((f) => f.header);
  if (missing.length) return { rows: [], errors: [`Missing required column(s): ${missing.join(", ")}. Please use the downloaded template.`] };

  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values = def.fields.map((f) => (colByKey.has(f.key) ? row.getCell(colByKey.get(f.key)!).value : null));
    if (values.every((v) => v === null || v === undefined || String(v).trim() === "")) return;
    const r = parseRow(def, (f) => values[def.fields.indexOf(f)]);
    if (r.ok) rows.push(r.data);
    else errors.push(...r.errors.map((e) => `Row ${n}: ${e}`));
  });
  if (!rows.length && !errors.length) errors.push("No data rows found in the Data sheet");
  return { rows, errors };
}
