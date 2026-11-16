// Convert raw cell/form values into typed data, with friendly error messages.
import type { Field, MasterDef } from "./config";

export type RowResult = { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] };

const TRUE = new Set(["true", "yes", "y", "1", "x"]);
const FALSE = new Set(["false", "no", "n", "0"]);

export function parseValue(f: Field, raw: unknown): { value: unknown; error?: string } {
  if (raw && typeof raw === "object" && !(raw instanceof Date)) {
    // exceljs rich text / formula / hyperlink cells
    const o = raw as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    raw = o.result ?? o.text ?? o.richText?.map((r) => r.text).join("") ?? "";
  }
  const s = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? "").trim();
  if (s === "") {
    if (f.required) return { value: undefined, error: `${f.header} is required` };
    return { value: undefined };
  }
  switch (f.type) {
    case "text":
      return { value: s };
    case "enum": {
      const u = s.toUpperCase().replace(/[\s-]+/g, "_");
      if (!f.options!.includes(u)) return { value: undefined, error: `${f.header} must be one of ${f.options!.join(", ")}` };
      return { value: u };
    }
    case "bool": {
      const l = s.toLowerCase();
      if (TRUE.has(l)) return { value: true };
      if (FALSE.has(l)) return { value: false };
      return { value: undefined, error: `${f.header} must be TRUE or FALSE` };
    }
    case "number": {
      const n = s.replace(/,/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(n)) return { value: undefined, error: `${f.header} must be a number` };
      return { value: n };
    }
    case "int": {
      const n = s.replace(/,/g, "");
      if (!/^\d+$/.test(n)) return { value: undefined, error: `${f.header} must be a whole number` };
      return { value: parseInt(n, 10) };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) return { value: undefined, error: `${f.header} must be a date (YYYY-MM-DD)` };
      return { value: new Date(s + "T00:00:00.000Z") };
    }
  }
}

export function parseRow(def: MasterDef, get: (f: Field) => unknown): RowResult {
  const data: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of def.fields) {
    const { value, error } = parseValue(f, get(f));
    if (error) errors.push(error);
    else if (value !== undefined) data[f.key] = value;
  }
  if (typeof data.code === "string") data.code = data.code.toUpperCase();
  if (def.kind === "currencies" && typeof data.code === "string" && !/^[A-Z]{3}$/.test(data.code)) {
    errors.push("Currency Code must be 3 letters, e.g. USD");
  }
  return errors.length ? { ok: false, errors } : { ok: true, data };
}
