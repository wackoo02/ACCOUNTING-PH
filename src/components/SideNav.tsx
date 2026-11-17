"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { matchNav, type NavSection } from "@/lib/nav-match";
import type { IconName } from "@/lib/icons";

/** Dark sidebar: Home link, one expandable group per module, AI assistant and help cards at the bottom. */
export function SideNav({ sections, comingNext }: { sections: NavSection[]; comingNext: { label: string; icon: IconName }[] }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const match = matchNav(sections, pathname, search);
  const active = match?.item.href;
  const activeSection = match?.section ?? null;
  const [open, setOpen] = useState<string | null>(activeSection);
  useEffect(() => { if (activeSection) setOpen(activeSection); }, [activeSection]);
  // Close the mobile drawer after navigating.
  useEffect(() => { document.body.classList.remove("nav-open"); }, [pathname, search]);

  const top = sections.find((s) => !s.title)?.items ?? [];
  const groups = sections.filter((s) => s.title && s.items.length > 0);
  return (
    <>
      <div className="nav-scroll">
        {top.map((i) => (
          <Link key={i.href} href={i.href} className={"nav-home" + (i.href === active ? " active" : "")} aria-current={i.href === active ? "page" : undefined}>
            <Icon name="home" size={19} /><span>Home</span>
          </Link>
        ))}
        {groups.map((s) => {
          const isOpen = open === s.title;
          const here = activeSection === s.title;
          return (
            <div key={s.title} className={"nav-group" + (isOpen ? " open" : "") + (here ? " here" : "")}>
              <button type="button" className="nav-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.title)}>
                <Icon name={s.icon ?? s.items[0].icon} size={19} />
                <span>{s.title}</span>
                <Icon name="chevron" size={15} className="chev" />
              </button>
              <div className="nav-items" hidden={!isOpen}>
                {s.items.map((i) => (
                  <Link key={i.href} href={i.href} className={i.href === active ? "active" : undefined} aria-current={i.href === active ? "page" : undefined}>
                    <span>{i.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        {comingNext.length > 0 && (
          <>
            <div className="sect">Coming next</div>
            {comingNext.map((m) => (
              <div key={m.label} className="soon"><Icon name={m.icon} size={15} /><span>{m.label}</span></div>
            ))}
          </>
        )}
      </div>
      <div className="side-cards">
        <Link href="/dashboard#assistant" className="side-card ai">
          <span className="ai-badge">AI</span>
          <span>AI Assistant</span>
          <Icon name="chevron" size={15} className="chev" />
        </Link>
        <button type="button" className="side-card help" onClick={() => window.dispatchEvent(new Event("veritus:search"))}>
          <Icon name="help" size={22} />
          <span><strong>Need help?</strong><small>Search any page or ask the assistant</small></span>
        </button>
      </div>
    </>
  );
}
