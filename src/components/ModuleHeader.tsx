"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { matchNav, type NavSection } from "@/lib/nav-match";

/** Breadcrumb strip with the module's icon, shown above every page. */
export function ModuleHeader({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const m = matchNav(sections, pathname, search);
  if (!m || pathname === "/dashboard") return null;
  return (
    <div className="module-head" key={m.item.href}>
      <span className="module-tile"><Icon name={m.item.icon} size={20} /></span>
      <span className="crumbs">
        {m.section && <span className="muted">{m.section}</span>}
        {m.section && <span className="sep">/</span>}
        <strong>{m.item.label}</strong>
      </span>
    </div>
  );
}
