"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { matchNav, type NavSection } from "@/lib/nav-match";
import type { IconName } from "@/lib/icons";

export function SideNav({ sections, comingNext }: { sections: NavSection[]; comingNext: { label: string; icon: IconName }[] }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const active = matchNav(sections, pathname, search)?.item.href;
  return (
    <>
      {sections.map((s) => (
        <div key={s.title ?? "_"} className="nav-group">
          {s.title && <div className="sect">{s.title}</div>}
          {s.items.map((i) => (
            <Link key={i.href} href={i.href} className={i.href === active ? "active" : undefined} aria-current={i.href === active ? "page" : undefined}>
              <Icon name={i.icon} size={17} />
              <span>{i.label}</span>
            </Link>
          ))}
        </div>
      ))}
      <div className="sect">Coming next</div>
      {comingNext.map((m) => (
        <div key={m.label} className="soon"><Icon name={m.icon} size={15} /><span>{m.label}</span></div>
      ))}
    </>
  );
}
