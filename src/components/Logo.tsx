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
      <path d="M16 18 L32 48 L48 18" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="48" cy="18" r="4.5" fill="#E9D5FF" />
    </svg>
  );
}

export function Logo({ tagline = false, dark = false }: { tagline?: boolean; dark?: boolean }) {
  return (
    <div className="logo">
      <LogoMark />
      <div>
        <div className="logo-name" style={{ color: dark ? "#fff" : "var(--ink)" }}>{BRAND.name}</div>
        {tagline && <div className="logo-tag">{BRAND.tagline}</div>}
      </div>
    </div>
  );
}
