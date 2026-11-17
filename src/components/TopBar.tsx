"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import type { NavSection } from "@/lib/nav-match";
import type { IconName } from "@/lib/icons";

type Note = { id: string; tone: string; title: string; detail: string; href: string; icon: IconName };
type Hit = { group: string; label: string; hint?: string; href: string; icon?: IconName; ask?: boolean };

export function TopBar(props: {
  sections: NavSection[];
  user: { name: string; role: string; email: string };
  org: { id: string; name: string };
  memberships: { organizationId: string; name: string }[];
  notes: Note[];
  changeCompany: (fd: FormData) => Promise<void>;
  logout: () => Promise<void>;
}) {
  const [menu, setMenu] = useState<null | "bell" | "user">(null);
  const [palette, setPalette] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); }
      if (e.key === "Escape") { setMenu(null); setPalette(false); }
    };
    const open = () => setPalette(true);
    const click = (e: MouseEvent) => { if (bar.current && !bar.current.contains(e.target as Node)) setMenu(null); };
    window.addEventListener("keydown", key);
    window.addEventListener("veritus:search", open);
    document.addEventListener("mousedown", click);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("veritus:search", open); document.removeEventListener("mousedown", click); };
  }, []);

  const initials = props.user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const urgent = props.notes.filter((n) => n.tone === "danger").length;
  return (
    <div className="topbar noprint" ref={bar}>
      <button type="button" className="icon-btn burger" aria-label="Open menu" onClick={() => document.body.classList.toggle("nav-open")}><Icon name="menu" size={20} /></button>
      <button type="button" className="search-box" onClick={() => setPalette(true)}>
        <Icon name="search" size={18} />
        <span>Search anything (customer, item, invoice, report)</span>
        <kbd>Ctrl + K</kbd>
      </button>
      <div className="top-actions">
        <div className="pop-wrap">
          <button type="button" className="icon-btn" aria-label={`Notifications (${props.notes.length})`} aria-expanded={menu === "bell"} onClick={() => setMenu(menu === "bell" ? null : "bell")}>
            <Icon name="bell" size={20} />
            {props.notes.length > 0 && <span className={"dot" + (urgent ? " urgent" : "")}>{props.notes.length > 9 ? "9+" : props.notes.length}</span>}
          </button>
          {menu === "bell" && (
            <div className="pop pop-notes" role="menu">
              <div className="pop-title">Notifications</div>
              {props.notes.length === 0 && <div className="pop-empty">You are all caught up.</div>}
              {props.notes.map((n) => (
                <Link key={n.id} href={n.href} className={`note ${n.tone}`} onClick={() => setMenu(null)}>
                  <span className="note-icon"><Icon name={n.icon} size={16} /></span>
                  <span><strong>{n.title}</strong><small>{n.detail}</small></span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <Link href="/settings" className="icon-btn" aria-label="Company settings"><Icon name="settings" size={20} /></Link>
        <div className="pop-wrap">
          <button type="button" className="user-btn" aria-expanded={menu === "user"} onClick={() => setMenu(menu === "user" ? null : "user")}>
            <span className="avatar">{initials}</span>
            <span className="who"><strong>{props.user.name}</strong><small>{props.user.role} · {props.org.name}</small></span>
            <Icon name="chevron" size={14} className="chev-down" />
          </button>
          {menu === "user" && (
            <div className="pop pop-user" role="menu">
              <div className="pop-title">{props.user.email}</div>
              {props.memberships.length > 1 && (
                <>
                  <div className="pop-sub">Switch company</div>
                  {props.memberships.map((m) => (
                    <form key={m.organizationId} action={props.changeCompany}>
                      <input type="hidden" name="organizationId" value={m.organizationId} />
                      <button className={"pop-item" + (m.organizationId === props.org.id ? " on" : "")} disabled={m.organizationId === props.org.id}>{m.name}</button>
                    </form>
                  ))}
                  <hr />
                </>
              )}
              <Link href="/portal" className="pop-item" onClick={() => setMenu(null)}>My employee portal</Link>
              <form action={props.logout}><button className="pop-item"><Icon name="signout" size={16} /> Sign out</button></form>
            </div>
          )}
        </div>
      </div>
      {/* Portaled: the bar's backdrop blur would otherwise trap fixed overlays inside it. */}
      {mounted && createPortal(<div className="nav-scrim noprint" aria-hidden="true" onClick={() => document.body.classList.remove("nav-open")} />, document.body)}
      {palette && createPortal(<Palette sections={props.sections} onClose={() => setPalette(false)} />, document.body)}
    </div>
  );
}

function Palette({ sections, onClose }: { sections: NavSection[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [records, setRecords] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const pages = useMemo(() => sections.flatMap((s) => s.items.map((i) => ({ group: "Pages", label: i.label, hint: s.title ?? "", href: i.href, icon: i.icon }))), [sections]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRecords([]); return; }
    const ctl = new AbortController();
    const h = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(t)}`, { signal: ctl.signal }).then((r) => r.json()).then((j) => setRecords(j.results ?? [])).catch(() => {});
    }, 180);
    return () => { clearTimeout(h); ctl.abort(); };
  }, [q]);

  const t = q.trim().toLowerCase();
  const pageHits = (t ? pages.filter((p) => `${p.label} ${p.hint}`.toLowerCase().includes(t)) : pages.slice(0, 8)).slice(0, 8);
  const hits: Hit[] = [...pageHits, ...records];
  if (t) hits.push({ group: "AI assistant", label: `Ask: "${q.trim()}"`, href: `/dashboard?ask=${encodeURIComponent(q.trim())}#assistant`, icon: "sparkle", ask: true });
  useEffect(() => setSel(0), [q]);

  const go = useCallback((h: Hit) => { onClose(); router.push(h.href); }, [onClose, router]);
  let last = "";
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, customers, items, invoices, or ask a question"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && hits[sel]) { e.preventDefault(); go(hits[sel]); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {hits.length === 0 && <div className="pop-empty">No matches.</div>}
          {hits.map((h, i) => {
            const head = h.group !== last ? h.group : null;
            last = h.group;
            return (
              <div key={`${h.group}-${h.href}-${i}`}>
                {head && <div className="palette-group">{head}</div>}
                <button type="button" className={"palette-hit" + (i === sel ? " on" : "") + (h.ask ? " ask" : "")} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                  <Icon name={h.icon ?? (h.group === "Documents" ? "journal" : "customers")} size={17} />
                  <span className="lbl">{h.label}</span>
                  {h.hint && <span className="hint">{h.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
