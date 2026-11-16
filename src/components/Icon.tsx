import { ICONS, type IconDef, type IconName } from "@/lib/icons";

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const def = ICONS[name] as IconDef | undefined;
  if (!def) return null;
  return (
    <svg
      className={"icon " + (className ?? "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {def.map((s, i) => (
        <path key={i} d={s.d} stroke={s.a ? "var(--accent)" : "currentColor"} />
      ))}
    </svg>
  );
}
