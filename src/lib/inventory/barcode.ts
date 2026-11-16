// Code 128 (set B) barcode as SVG, readable by any USB/Bluetooth scanner. No library needed.
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];

/** Bars for `text` (printable ASCII 32-126). Returns module widths alternating bar/space. */
export function code128B(text: string): number[] {
  const codes = [104];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error("Code 128B supports printable ASCII only");
    codes.push(c - 32);
  }
  const check = codes.reduce((s, c, i) => s + c * (i === 0 ? 1 : i), 0) % 103;
  codes.push(check, 106);
  return codes.flatMap((c) => PATTERNS[c].split("").map(Number));
}

export function barcodeSvg(text: string, opts: { height?: number; module?: number } = {}) {
  const h = opts.height ?? 50, m = opts.module ?? 1.5;
  const widths = [10, ...code128B(text), 10]; // quiet zones (spaces) at both ends
  let x = 0, rects = "";
  widths.forEach((w, i) => {
    // index 0 is the leading quiet zone (space); then bar, space, bar...
    if (i > 0 && i < widths.length - 1 && i % 2 === 1) rects += `<rect x="${x * m}" y="0" width="${w * m}" height="${h}"/>`;
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto" width="${x * m}" height="${h}" viewBox="0 0 ${x * m} ${h}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
