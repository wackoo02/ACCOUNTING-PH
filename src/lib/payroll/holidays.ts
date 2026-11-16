// Philippine national holidays. Years with a published proclamation use it as issued;
// other years are generated from the usual rules (fixed dates, Holy Week, last Monday of August).
// Eid'l Fitr and Eid'l Adha are proclaimed separately each year: add them manually when announced.

export type HolidayDef = { date: string; name: string; type: "REGULAR" | "SPECIAL" | "SPECIAL_WORKING" };

// Proclamation No. 1006 (s. 2025): holidays for 2026.
const PROCLAIMED: Record<number, HolidayDef[]> = {
  2026: [
    { date: "2026-01-01", name: "New Year's Day", type: "REGULAR" },
    { date: "2026-02-17", name: "Chinese New Year", type: "SPECIAL" },
    { date: "2026-02-25", name: "EDSA People Power Revolution Anniversary", type: "SPECIAL_WORKING" },
    { date: "2026-04-02", name: "Maundy Thursday", type: "REGULAR" },
    { date: "2026-04-03", name: "Good Friday", type: "REGULAR" },
    { date: "2026-04-04", name: "Black Saturday", type: "SPECIAL" },
    { date: "2026-04-09", name: "Araw ng Kagitingan", type: "REGULAR" },
    { date: "2026-05-01", name: "Labor Day", type: "REGULAR" },
    { date: "2026-06-12", name: "Independence Day", type: "REGULAR" },
    { date: "2026-08-21", name: "Ninoy Aquino Day", type: "SPECIAL" },
    { date: "2026-08-31", name: "National Heroes Day", type: "REGULAR" },
    { date: "2026-11-01", name: "All Saints' Day", type: "SPECIAL" },
    { date: "2026-11-02", name: "All Souls' Day", type: "SPECIAL" },
    { date: "2026-11-30", name: "Bonifacio Day", type: "REGULAR" },
    { date: "2026-12-08", name: "Feast of the Immaculate Conception of Mary", type: "SPECIAL" },
    { date: "2026-12-24", name: "Christmas Eve", type: "SPECIAL" },
    { date: "2026-12-25", name: "Christmas Day", type: "REGULAR" },
    { date: "2026-12-30", name: "Rizal Day", type: "REGULAR" },
    { date: "2026-12-31", name: "Last Day of the Year", type: "SPECIAL" },
  ],
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

function lastMondayOfAugust(y: number) {
  const d = new Date(Date.UTC(y, 7, 31));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function nationalHolidays(year: number): { holidays: HolidayDef[]; proclaimed: boolean } {
  if (PROCLAIMED[year]) return { holidays: PROCLAIMED[year], proclaimed: true };
  const e = easter(year);
  const list: HolidayDef[] = [
    { date: iso(year, 1, 1), name: "New Year's Day", type: "REGULAR" },
    { date: shift(e, -3), name: "Maundy Thursday", type: "REGULAR" },
    { date: shift(e, -2), name: "Good Friday", type: "REGULAR" },
    { date: shift(e, -1), name: "Black Saturday", type: "SPECIAL" },
    { date: iso(year, 4, 9), name: "Araw ng Kagitingan", type: "REGULAR" },
    { date: iso(year, 5, 1), name: "Labor Day", type: "REGULAR" },
    { date: iso(year, 6, 12), name: "Independence Day", type: "REGULAR" },
    { date: iso(year, 8, 21), name: "Ninoy Aquino Day", type: "SPECIAL" },
    { date: lastMondayOfAugust(year), name: "National Heroes Day", type: "REGULAR" },
    { date: iso(year, 11, 1), name: "All Saints' Day", type: "SPECIAL" },
    { date: iso(year, 11, 2), name: "All Souls' Day", type: "SPECIAL" },
    { date: iso(year, 11, 30), name: "Bonifacio Day", type: "REGULAR" },
    { date: iso(year, 12, 8), name: "Feast of the Immaculate Conception of Mary", type: "SPECIAL" },
    { date: iso(year, 12, 24), name: "Christmas Eve", type: "SPECIAL" },
    { date: iso(year, 12, 25), name: "Christmas Day", type: "REGULAR" },
    { date: iso(year, 12, 30), name: "Rizal Day", type: "REGULAR" },
    { date: iso(year, 12, 31), name: "Last Day of the Year", type: "SPECIAL" },
  ];
  return { holidays: list.sort((a, b) => a.date.localeCompare(b.date)), proclaimed: false };
}

// Standard leave types. Statutory ones follow the Labor Code and special laws; SL/VL/EL credits are company policy.
export const DEFAULT_LEAVE_TYPES = [
  { code: "VL", name: "Vacation leave", paid: true, annualCredits: 15, requiresBalance: true, description: "Company policy." },
  { code: "SL", name: "Sick leave", paid: true, annualCredits: 15, requiresBalance: true, description: "Company policy." },
  { code: "EL", name: "Emergency leave", paid: true, annualCredits: 3, requiresBalance: true, description: "Company policy." },
  { code: "SIL", name: "Service incentive leave", paid: true, annualCredits: 5, requiresBalance: true, description: "Labor Code Art. 95: 5 days after one year of service (if no VL/SL of at least 5 days)." },
  { code: "ML", name: "Maternity leave", paid: true, annualCredits: 105, requiresBalance: false, description: "RA 11210: 105 days (120 for solo parents, 60 for miscarriage); SSS maternity benefit." },
  { code: "PL", name: "Paternity leave", paid: true, annualCredits: 7, requiresBalance: true, description: "RA 8187: 7 days for each of the first four deliveries of the legitimate spouse." },
  { code: "SPL", name: "Solo parent leave", paid: true, annualCredits: 7, requiresBalance: true, description: "RA 11861: 7 working days per year after 6 months of service." },
  { code: "VAWC", name: "VAWC leave", paid: true, annualCredits: 10, requiresBalance: true, description: "RA 9262: up to 10 days for victims of violence against women and their children." },
  { code: "SLW", name: "Special leave for women", paid: true, annualCredits: 60, requiresBalance: false, description: "RA 9710 (Magna Carta of Women): up to 2 months after surgery for gynecological disorders." },
  { code: "BL", name: "Bereavement leave", paid: true, annualCredits: 3, requiresBalance: true, description: "Company policy." },
  { code: "LWOP", name: "Leave without pay", paid: false, annualCredits: 0, requiresBalance: false, description: "Unpaid; deducted from pay." },
];

export const DEFAULT_SHIFTS = [
  { code: "DAY", name: "Day shift 8:00 AM - 5:00 PM", startTime: "08:00", endTime: "17:00", breakMinutes: 60, graceMinutes: 5, restDays: "0,6" },
  { code: "MID", name: "Mid shift 2:00 PM - 11:00 PM", startTime: "14:00", endTime: "23:00", breakMinutes: 60, graceMinutes: 5, restDays: "0,6" },
  { code: "NIGHT", name: "Night shift 10:00 PM - 7:00 AM", startTime: "22:00", endTime: "07:00", breakMinutes: 60, graceMinutes: 5, restDays: "0,6" },
];
