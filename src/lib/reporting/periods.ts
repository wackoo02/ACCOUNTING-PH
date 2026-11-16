// Turns relative period specs ("this month", "same quarter last year") into real date ranges.
import type { PeriodSpec } from "./definition";

export type ResolvedPeriod = { id: string; label: string; from: Date; to: Date };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)); // m is 0-based and may overflow
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function resolveAsOf(asOf: string, now = new Date()): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return new Date(`${asOf}T00:00:00Z`);
  const t = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (asOf === "end_of_last_month") return utc(t.getUTCFullYear(), t.getUTCMonth(), 0);
  return t;
}

/** Fiscal year (named by the calendar year it ends in) that contains d. */
function fyStart(startMonth: number, d: Date) {
  const m = d.getUTCMonth() + 1;
  const y = m >= startMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return utc(y, startMonth - 1, 1);
}
const fyName = (start: Date, startMonth: number) => (startMonth === 1 ? start.getUTCFullYear() : start.getUTCFullYear() + 1);

/** The same calendar date `years` earlier/later, clamped to the month end (Feb 29). */
function shiftYears(d: Date, years: number) {
  const y = d.getUTCFullYear() + years, m = d.getUTCMonth();
  const last = utc(y, m + 1, 0).getUTCDate();
  return utc(y, m, Math.min(d.getUTCDate(), last));
}

export function resolvePeriod(p: PeriodSpec, asOf: Date, fyStartMonth: number): ResolvedPeriod {
  const off = p.offset ?? 0;
  let from: Date, to: Date, label: string;
  switch (p.kind) {
    case "custom":
      from = new Date(`${p.from}T00:00:00Z`); to = new Date(`${p.to}T00:00:00Z`);
      if (from > to) [from, to] = [to, from];
      label = `${iso(from)} to ${iso(to)}`;
      break;
    case "month": {
      from = utc(asOf.getUTCFullYear(), asOf.getUTCMonth() + off, 1);
      to = utc(from.getUTCFullYear(), from.getUTCMonth() + 1, 0);
      label = `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
      break;
    }
    case "quarter": {
      const s = fyStart(fyStartMonth, asOf);
      const monthsIn = (asOf.getUTCFullYear() - s.getUTCFullYear()) * 12 + asOf.getUTCMonth() - s.getUTCMonth();
      const q = Math.floor(monthsIn / 3) + off; // quarter index from this FY start (may be negative)
      from = utc(s.getUTCFullYear(), s.getUTCMonth() + q * 3, 1);
      to = utc(from.getUTCFullYear(), from.getUTCMonth() + 3, 0);
      const fs = fyStart(fyStartMonth, from);
      const qn = Math.round(((from.getUTCFullYear() - fs.getUTCFullYear()) * 12 + from.getUTCMonth() - fs.getUTCMonth()) / 3) + 1;
      label = `Q${qn} FY${fyName(fs, fyStartMonth)}`;
      break;
    }
    case "ytd": {
      to = shiftYears(asOf, off);
      from = fyStart(fyStartMonth, to);
      label = off === 0 ? `Year to date ${iso(to)}` : `YTD ${iso(to)}`;
      break;
    }
    case "fy": {
      const s = fyStart(fyStartMonth, asOf);
      from = utc(s.getUTCFullYear() + off, s.getUTCMonth(), 1);
      to = utc(from.getUTCFullYear() + 1, from.getUTCMonth(), 0);
      label = `FY${fyName(from, fyStartMonth)}`;
      break;
    }
    case "to_date":
    default:
      to = shiftYears(asOf, off);
      from = utc(1900, 0, 1);
      label = `As of ${iso(to)}`;
  }
  return { id: p.id, label: p.label?.trim() || label, from, to };
}

export const fmtIso = iso;
