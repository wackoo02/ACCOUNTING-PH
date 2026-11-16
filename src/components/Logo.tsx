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
      <path d="M12.5 13.5 H23 L38.2 46.6 C39.6 50.6 37.2 53 34 53 C30.2 53 27.2 50.4 24.2 44.6 C17.4 31.6 11.2 22.4 11 17 C11 15 11.4 13.5 12.5 13.5 Z" fill="#fff" />
      <path d="M42.2 13.5 H54 C52 27 45.2 37.2 37.6 43.8 C37.8 33.4 39.4 23.4 42.2 13.5 Z" fill="#FF6B1A" />
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
