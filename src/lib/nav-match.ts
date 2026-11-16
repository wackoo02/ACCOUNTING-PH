import type { IconName } from "@/lib/icons";

export type NavItem = { href: string; label: string; icon: IconName; perm?: string };
export type NavSection = { title: string | null; items: NavItem[] };

/** Best nav match for a path + query string: exact href (with query) wins, then longest path prefix. */
export function matchNav(sections: NavSection[], pathname: string, search: string): { section: string | null; item: NavItem } | null {
  let best: { section: string | null; item: NavItem; score: number } | null = null;
  const full = pathname + (search ? `?${search}` : "");
  for (const s of sections) {
    for (const item of s.items) {
      const [path, query] = item.href.split("?");
      let score = -1;
      if (query) { if (full === item.href) score = 10_000; }
      else if (pathname === path) score = 5_000 + path.length;
      else if (pathname.startsWith(path + "/")) score = path.length;
      if (score >= 0 && (!best || score > best.score)) best = { section: s.title, item, score };
    }
  }
  return best && { section: best.section, item: best.item };
}
