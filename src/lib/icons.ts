// Veritus icon set. One source of truth for the web app, exported SVGs (brand/icons) and the mobile app.
// 24x24 grid, 1.75 stroke, round caps/joins. Each icon is a list of strokes; strokes marked `a`
// are drawn in the accent colour (digital orange) to give the duotone look.

export type IconStroke = { d: string; a?: boolean };
export type IconDef = IconStroke[];

const rr = (x: number, y: number, w: number, h: number, r: number, a = false): IconStroke => ({
  d: `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`,
  a,
});
const circle = (cx: number, cy: number, r: number, a = false): IconStroke => ({
  d: `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0z`,
  a,
});
const p = (d: string, a = false): IconStroke => ({ d, a });

const doc = p("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z");
const docFold = p("M14 3v5h5");
const bank: IconDef = [p("M3 9.5L12 4l9 5.5", true), p("M5.5 10.5V18M10 10.5V18M14 10.5V18M18.5 10.5V18"), p("M3.5 21h17")];
const people: IconDef = [
  circle(9, 8, 3.5),
  p("M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"),
  p("M16 4.6a3.5 3.5 0 0 1 0 6.8", true),
  p("M18.5 15.3c1.6.8 2.6 2.4 3 4.7", true),
];

export const ICONS = {
  dashboard: [rr(3, 3, 7, 9, 1.5), rr(14, 3, 7, 5, 1.5), rr(14, 12, 7, 9, 1.5, true), rr(3, 16, 7, 5, 1.5)],
  journal: [p("M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"), p("M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"), p("M9 7.5h6M9 11h4", true)],
  "journal-new": [doc, docFold, p("M12 11.5v6M9 14.5h6", true)],
  approvals: [p("M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"), p("M9 12l2 2 4-4", true)],
  recurring: [p("M20 11a8 8 0 0 0-14.5-4.5L4 8"), p("M4 4v4h4"), p("M4 13a8 8 0 0 0 14.5 4.5L20 16"), p("M20 20v-4h-4"), circle(12, 12, 1.6, true)],
  allocations: [p("M10.5 4.1A8 8 0 1 0 19.9 13.5H10.5z"), p("M14 3a7 7 0 0 1 7 7h-7z", true)],
  intercompany: [rr(2.5, 3.5, 7, 7, 1.5), rr(14.5, 13.5, 7, 7, 1.5), p("M9.5 7h5a3 3 0 0 1 3 3v3.5", true), p("M15.8 11.8l1.7 1.7 1.7-1.7", true), p("M14.5 17h-5a3 3 0 0 1-3-3v-3.5"), p("M4.8 12.2l1.7-1.7 1.7 1.7")],
  fx: [circle(9, 9, 6), p("M15.5 9.3A6 6 0 1 1 9.3 15.5", true), p("M6.5 9h5M9.5 7l2 2-2 2")],
  periods: [rr(3, 5, 18, 16, 2), p("M3 10h18"), p("M8 3v4M16 3v4"), rr(9.5, 14, 5, 4, 1, true), p("M10.5 14v-1a1.5 1.5 0 0 1 3 0v1", true)],
  bank,
  cash: [p("M8 20V5"), p("M4.5 8.5L8 5l3.5 3.5"), p("M16 4v15", true), p("M12.5 15.5L16 19l3.5-3.5", true)],
  "voucher-approvals": [doc, docFold, p("M9 14l2 2 4-4", true)],
  "petty-cash": [p("M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 18.5 7h-13"), p("M21 11.5h-4a1.5 1.5 0 0 0 0 3h4z", true)],
  checks: [rr(2.5, 6, 19, 12, 2), p("M6 10h4M6 14.5h5"), p("M14 14c1-1.5 1.8 1.2 2.8 0s1.6-.4 2.2.3", true)],
  statements: [doc, docFold, p("M8.5 12.5h7M8.5 16h7"), p("M8.5 9h3", true)],
  reconcile: [p("M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"), rr(9, 7, 12, 14, 2), p("M12.5 14l2 2 3.5-3.5", true)],
  "trial-balance": [p("M12 4v16M8 20h8M5 7h14"), p("M5 7l-3 6a3 3 0 0 0 6 0z", true), p("M19 7l-3 6a3 3 0 0 0 6 0z", true)],
  "balance-sheet": [p("M12 3l9 4.5-9 4.5-9-4.5z", true), p("M3 12l9 4.5 9-4.5"), p("M3 16.5L12 21l9-4.5")],
  "income-statement": [p("M3 3v18h18"), p("M7 15l4-4 3 3 5-6", true), p("M15 8h4v4", true)],
  "cash-flow": [p("M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0"), p("M3 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0", true), p("M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0")],
  "gl-listing": [p("M9 6h12M9 12h12M9 18h12"), circle(4.5, 6, 1.1, true), circle(4.5, 12, 1.1, true), circle(4.5, 18, 1.1, true)],
  ledger: [p("M3 5.5C5.5 4 9 4 12 6c3-2 6.5-2 9-.5V19c-2.5-1.5-6-1.5-9 .5-3-2-6.5-2-9-.5z"), p("M12 6v13.5"), p("M15 9.5h3M15 13h3", true)],
  activity: [rr(2.5, 3.5, 19, 17, 3), p("M6 12h2.5l2-4.5 3 9 2-4.5H18", true)],
  budget: [circle(12, 12, 9), circle(12, 12, 5), circle(12, 12, 1.5, true), p("M12 12l7-7M16 4.5h3.5V8", true)],
  "report-builder": [rr(3, 3, 18, 18, 2.5), p("M7 8h10M7 12h10M7 16h10"), circle(10, 8, 1.6, true), circle(15, 12, 1.6, true), circle(9, 16, 1.6, true)],
  consolidated: [rr(3, 3, 6, 6, 1.5), rr(15, 3, 6, 6, 1.5), rr(9, 15, 6, 6, 1.5, true), p("M6 9v2.5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 13.5V15")],
  accounts: [rr(3, 3, 7, 5, 1.5), p("M6.5 8v9.5A1.5 1.5 0 0 0 8 19h5M6.5 12H13"), rr(13, 9.5, 8, 5, 1.5, true), rr(13, 16.5, 8, 5, 1.5, true)],
  dimensions: [rr(3, 3, 8, 8, 1.5), rr(13, 3, 8, 8, 1.5), rr(3, 13, 8, 8, 1.5), rr(13, 13, 8, 8, 1.5, true)],
  taxes: [p("M6 3h12v18l-3-2-3 2-3-2-3 2z"), p("M9.5 14.5l5-5", true), circle(10, 10, 1, true), circle(14, 14, 1, true)],
  banks: bank,
  products: [p("M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"), circle(8, 8, 1.6, true)],
  employees: [rr(3, 5, 18, 14, 2), circle(9, 11, 2.2), p("M5.5 16.5c.8-1.6 2-2.4 3.5-2.4s2.7.8 3.5 2.4"), p("M15 10h3.5M15 13.5h3.5", true)],
  vendors: [p("M3 6h11v10H3z"), p("M14 9h4l3 3.5V16h-7"), circle(7, 17.5, 1.8, true), circle(17, 17.5, 1.8, true)],
  customers: [p("M4 10v10h16V10"), p("M3 10l1.5-6h15L21 10"), p("M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0", true), p("M10 20v-5h4v5")],
  currencies: [p("M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"), p("M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7"), p("M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5", true)],
  entities: [rr(9, 3, 6, 5, 1.5), rr(3, 16, 6, 5, 1.5), rr(15, 16, 6, 5, 1.5), p("M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2", true)],
  settings: [p("M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"), circle(15, 6, 2, true), circle(9, 12, 2, true), circle(17, 18, 2, true)],
  users: people,
  audit: [circle(10.5, 10.5, 6.5), p("M15.5 15.5l5 5", true), p("M8 10.5l2 2 3-3", true)],
  signout: [p("M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"), p("M10 17l5-5-5-5M15 12H4", true)],
  receivables: [doc, docFold, p("M12 10.5v6.5M9 14l3 3 3-3", true)],
  payables: [doc, docFold, p("M12 17v-6.5M9 13.5l3-3 3 3", true)],
  mobility: [p("M6.5 6h11l2.5 5.5V16a1 1 0 0 1-1 1h-1.5M6.5 6L4 11.5V16a1 1 0 0 0 1 1h1.5M9.3 17h5.4M4 11.5h16"), circle(7.5, 17, 1.8, true), circle(16.5, 17, 1.8, true)],
  payroll: [rr(2.5, 6, 19, 12, 2), circle(12, 12, 2.8, true), p("M6 9.5v5M18 9.5v5")],
  "fixed-assets": [p("M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"), p("M15 9h3a2 2 0 0 1 2 2v10"), p("M3 21h18"), p("M8 7h3M8 11h3M8 15h3", true)],
  prepaid: [p("M6 3h12M6 21h12"), p("M7.5 3v2.5c0 2 1.8 3.5 4.5 6.5-2.7 3-4.5 4.5-4.5 6.5V21M16.5 3v2.5c0 2-1.8 3.5-4.5 6.5 2.7 3 4.5 4.5 4.5 6.5V21"), p("M9.5 18.5h5", true)],
  leases: [circle(8, 15, 4), p("M11 12l9-9"), p("M16 7l2.5 2.5M18.5 4.5L21 7", true)],
  debt: [circle(12, 12, 9), p("M9 15l6-6", true), circle(9.3, 9.3, 1, true), circle(14.7, 14.7, 1, true)],
  inventory: [p("M12 3l8 4v10l-8 4-8-4V7z"), p("M4 7l8 4 8-4M12 11v10"), p("M8 5l8 4", true)],
  bir: [p("M9 3h6v4.5c0 1.5 1 2.5 2 3.5H7c1-1 2-2 2-3.5z"), rr(4, 11, 16, 5, 1.5), p("M5 20h14", true)],
  // Veritus Mobility tiles
  travel: [p("M21 15.5l-8-4.5V5.5a1.5 1.5 0 0 0-3 0V11l-8 4.5V17l8-2.5V19l-2.5 1.5V22L12 21l4.5 1v-1.5L14 19v-4.5l7 2.5z"), p("M3 8.5h4M17 8.5h4M15.5 5h3", true)],
  transport: [p("M5 11l1.6-4.3A2 2 0 0 1 8.5 5.4h7a2 2 0 0 1 1.9 1.3L19 11"), rr(3, 11, 18, 6, 2), p("M5 17v2M19 17v2"), circle(7.5, 14, 1, true), circle(16.5, 14, 1, true), p("M10 14h4", true)],
  "sent-package": [p("M12 3l8 4.5v9L12 21l-8-4.5v-9z"), p("M4 7.5l8 4.5 8-4.5M12 12v9"), p("M8 5.3l8 4.5", true)],
  "asset-audit": [p("M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"), rr(7, 7, 4, 4, .8), rr(13, 7, 4, 4, .8), rr(7, 13, 4, 4, .8), p("M13 13h1.5v1.5M17 13v1M13 17h4v-1.5", true), p("M3 12h18", true)],
  camera: [p("M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"), circle(12, 13.5, 3.5, true)],
  receipt: [p("M6 3h12v18l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3L6 21z"), p("M9 8h6M9 11.5h6", true), p("M9 15h3")],
  claims: [rr(4, 3, 16, 18, 2), p("M8 8h8M8 12h5"), p("M12.5 17l1.8 1.8 3.2-3.6", true)],
  wallet: [p("M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 18.5 7h-13"), p("M21 11.5h-4a1.5 1.5 0 0 0 0 3h4z", true)],
  "cash-out": [p("M12 4v12"), p("M8 12l4 4 4-4"), p("M4 20h16", true)],
  inbox: [p("M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"), p("M3 13h5l1.5 2.5h5L16 13h5", true)],
  cart: [p("M3 4h2.5l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L21 8H6.3"), circle(9.5, 19.5, 1.5, true), circle(17, 19.5, 1.5, true)],
  receive: [p("M3 8l9-5 9 5v8l-9 5-9-5z"), p("M3 8l9 5 9-5M12 13v8", true)],
  aging: [circle(12, 12, 8.5), p("M12 7v5l3.5 2", true)],
  ratio: [p("M5 19L19 5"), circle(7, 7, 2.5, true), circle(17, 17, 2.5, true)],
  search: [circle(10.5, 10.5, 6.5), p("M15.5 15.5L20.5 20.5", true)],
  bell: [p("M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"), p("M10 20.5a2 2 0 0 0 4 0", true)],
  chevron: [p("M9 6l6 6-6 6")],
  home: [p("M3.5 11L12 4l8.5 7"), p("M5.5 9.5V20h13V9.5"), p("M10 20v-5.5h4V20", true)],
  sparkle: [p("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"), p("M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z", true)],
  help: [p("M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z"), p("M10 8.8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M12 14h.01", true)],
  send: [p("M4 12l16-8-6 16-2.5-6.5z"), p("M11.5 13.5L20 4", true)],
  trend: [p("M3 17l6-6 4 4 8-8"), p("M15 7h6v6", true)],
  alert: [p("M12 3.5L2.5 20h19z"), p("M12 10v4.5M12 17.5h.01", true)],
  info: [circle(12, 12, 8.5), p("M12 11v5.5M12 7.8h.01", true)],
  menu: [p("M4 7h16M4 12h16M4 17h16")],
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

export function iconSvg(name: IconName, opts: { size?: number; color?: string; accent?: string; stroke?: number } = {}): string {
  const { size = 24, color = "#1E1338", accent = "#FF6B1A", stroke = 1.75 } = opts;
  const paths = (ICONS[name] as IconDef)
    .map((s) => `<path d="${s.d}" stroke="${s.a ? accent : color}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
