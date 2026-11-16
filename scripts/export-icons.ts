// Writes brand/icons/*.svg (light + dark) and brand/icons/icons.json for the mobile app.
import { mkdirSync, writeFileSync } from "node:fs";
import { ICONS, iconSvg, type IconName } from "../src/lib/icons";

const out = "brand/icons";
mkdirSync(`${out}/light`, { recursive: true });
mkdirSync(`${out}/dark`, { recursive: true });
const names = Object.keys(ICONS) as IconName[];
for (const n of names) {
  writeFileSync(`${out}/light/${n}.svg`, iconSvg(n, { color: "#1E1338" }));
  writeFileSync(`${out}/dark/${n}.svg`, iconSvg(n, { color: "#FFFFFF" }));
}
writeFileSync(`${out}/icons.json`, JSON.stringify({ grid: 24, stroke: 1.75, colors: { ink: "#1E1338", accent: "#FF6B1A", brand: "#6D28D9" }, icons: ICONS }, null, 2));
const cells = names.map((n) => `<div class="c"><div class="t">${iconSvg(n, { size: 30, color: "#1E1338" })}</div><span>${n}</span></div>`).join("");
const darkCells = names.map((n) => `<div class="c d"><div class="t">${iconSvg(n, { size: 30, color: "#FFFFFF" })}</div><span>${n}</span></div>`).join("");
writeFileSync(`${out}/preview.html`, `<!doctype html><meta charset="utf-8"><title>Veritus icons</title><style>body{font:12px system-ui;margin:24px;background:#fff}h2{font:600 14px system-ui;margin:16px 0 8px}.g{display:grid;grid-template-columns:repeat(8,1fr);gap:10px}.c{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 4px;border:1px solid #eee;border-radius:10px}.c span{color:#5f6b7a}.t{width:48px;height:48px;border-radius:12px;background:#f3edff;display:grid;place-items:center}.d{background:#1E1338;border-color:#1E1338}.d .t{background:#352258}.d span{color:#d9d2ea}</style><h2>Veritus module icons — light</h2><div class="g">${cells}</div><h2>Dark</h2><div class="g">${darkCells}</div>`);
console.log(`${names.length} icons exported to ${out}`);
