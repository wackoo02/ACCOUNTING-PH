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
      <path transform="translate(32 32) scale(0.08 -0.074) translate(-353.5 -350)" d="M32 0V145L422 599L451 517H42V700H659V555L269 101L240 183H675V0Z" fill="#000" />
      <path transform="translate(31 33) scale(0.052 -0.052) translate(-393 -350)" d="M277 0 -19 700H235L476 109H325L573 700H805L509 0Z" fill="#fff" />
      <circle cx="51.5" cy="49" r="4.6" fill="#FF6B1A" />
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
