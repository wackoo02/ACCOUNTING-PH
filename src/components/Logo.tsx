import { Montserrat } from "next/font/google";

const wordmark = Montserrat({ subsets: ["latin"], weight: "600", display: "swap" });

export const BRAND = { name: "Veritus ERP", tagline: "Intelligent. Integrated. Compliant." };

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="vg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#5B21B6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#vg)" />
      <path transform="translate(32 31) scale(0.06 -0.06) translate(-393 -350)" d="M277 0 -19 700H235L476 109H325L573 700H805L509 0Z" fill="#fff" />
      <g fill="#1E1338" stroke="#1E1338" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="25.6" cy="38.8" r="2.2" stroke="none" />
        <path d="M26 41.6 L26.8 47.6" strokeWidth="3.6" fill="none" />
        <path d="M27.2 48.2 L31.2 44.6 L32.6 49" strokeWidth="2.6" fill="none" />
        <path d="M26.6 42.8 L31 45" strokeWidth="1.8" fill="none" />
        <rect x="33.6" y="48.4" width="5.6" height="1.5" rx="0.5" stroke="none" />
        <path d="M38.2 49 L39.8 49 L41.1 43.4 L39.5 43.4 Z" stroke="none" />
      </g>
      <circle cx="50.5" cy="49" r="4.4" fill="#FF6B1A" />
    </svg>
  );
}

export function Logo({ tagline = false, dark = false }: { tagline?: boolean; dark?: boolean }) {
  return (
    <div className="logo">
      <LogoMark />
      <div>
        <div className={"logo-name " + wordmark.className} style={{ color: dark ? "#fff" : "var(--ink)" }}>Veritus <span style={{ color: "var(--accent)" }}>ERP</span></div>
        {tagline && <div className="logo-tag">{BRAND.tagline}</div>}
      </div>
    </div>
  );
}
