// Server-rendered SVG charts for the home dashboard. Brand colours: purple for the main series, orange for the second.
import type { MonthPoint } from "@/lib/dashboard";

const W = 360, H = 250, L = 40, R = 8, T = 14, B = 28;

/** Rounds the axis maximum up to 1, 2, 2.5 or 5 x 10^n so ticks are readable. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
export const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return `${Math.round(v)}`;
};

function Axis({ max, ticks = 4 }: { max: number; ticks?: number }) {
  return (
    <g className="axis">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = (max / ticks) * i, y = T + (H - T - B) * (1 - i / ticks);
        return <g key={i}><line x1={L} x2={W - R} y1={y} y2={y} /><text x={L - 8} y={y + 4} textAnchor="end">{short(v)}</text></g>;
      })}
    </g>
  );
}

export function SalesTrend({ data }: { data: MonthPoint[] }) {
  const vals = data.map((d) => Math.max(0, d.revenue));
  const max = niceMax(Math.max(...vals, 0));
  const step = (W - L - R) / Math.max(1, data.length - 1);
  const x = (i: number) => L + i * step, y = (v: number) => T + (H - T - B) * (1 - v / max);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const lastI = vals.length - 1;
  const lx = Math.min(Math.max(x(lastI) - 80, L), W - R - 92);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Monthly revenue: ${data.map((d) => `${d.label} ${short(d.revenue)}`).join(", ")}`}>
      <defs>
        <linearGradient id="st-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7C3AED" stopOpacity=".28" />
          <stop offset="1" stopColor="#7C3AED" stopOpacity="0" />
        </linearGradient>
      </defs>
      <Axis max={max} />
      <path d={`M${x(0)},${y(0)} L${pts.join(" L")} L${x(lastI)},${y(0)} Z`} fill="url(#st-fill)" className="grow-in" />
      <polyline points={pts.join(" ")} fill="none" stroke="#6D28D9" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" className="draw-in" />
      {vals.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === lastI ? 5 : 3.5} fill={i === lastI ? "#FF6B1A" : "#fff"} stroke={i === lastI ? "#fff" : "#6D28D9"} strokeWidth="2"><title>{`${data[i].label}: ₱${data[i].revenue.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`}</title></circle>)}
      <g transform={`translate(${lx},${Math.max(2, y(vals[lastI]) - 50)})`} className="tip">
        <rect width="92" height="36" rx="7" />
        <text x="46" y="16" textAnchor="middle" className="tip-v">₱ {short(vals[lastI] ?? 0)}</text>
        <text x="46" y="29" textAnchor="middle" className="tip-l">{data[lastI]?.label} {data[lastI]?.key.slice(0, 4)}</text>
      </g>
      <g className="axis">{data.map((d, i) => <text key={d.key} x={x(i)} y={H - 8} textAnchor="middle">{d.label}</text>)}</g>
    </svg>
  );
}

export function CashFlowBars({ data }: { data: MonthPoint[] }) {
  const max = niceMax(Math.max(...data.flatMap((d) => [d.inflow, d.outflow]), 0));
  const band = (W - L - R) / data.length, bw = Math.min(14, band / 3.4);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Cash inflow and outflow by month: ${data.map((d) => `${d.label} in ${short(d.inflow)} out ${short(d.outflow)}`).join(", ")}`}>
      <Axis max={max} />
      {data.map((d, i) => {
        const cx = L + band * i + band / 2;
        return (
          <g key={d.key} className="bars">
            <rect x={cx - bw - 2} y={y(d.inflow)} width={bw} height={Math.max(0, y(0) - y(d.inflow))} rx="3" fill="#6D28D9"><title>{`${d.label} inflow: ₱${d.inflow.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`}</title></rect>
            <rect x={cx + 2} y={y(d.outflow)} width={bw} height={Math.max(0, y(0) - y(d.outflow))} rx="3" fill="#FF6B1A"><title>{`${d.label} outflow: ₱${d.outflow.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`}</title></rect>
            <text x={cx} y={H - 8} textAnchor="middle" className="axis-x">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
