// Duplicate detection for master records. Pure functions, no database, so they are
// easy to test and cheap to run on every "Add new" click.
import type { MasterKind } from "./config";

export type Candidate = {
  id: string;
  code: string;
  label: string; // display name
  tin?: string | null;
  email?: string | null;
  accountNumber?: string | null;
};

export type Probe = { name: string; code?: string; tin?: string; email?: string; accountNumber?: string };

export type SimilarMatch = { id: string; code: string; label: string; score: number; reason: string };

// Words that do not tell two companies apart. "ABC Trading Inc." and "ABC Trading Corporation" are the same supplier.
const NOISE = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "opc", "the", "and",
  "phils", "phil", "philippines", "ph", "intl", "international", "mr", "mrs", "ms", "sr", "jr",
]);

export function normalize(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NOISE.has(w))
    .join(" ");
}

const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "");

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prev2 = prev;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Swapped neighbours ("cahs" for "cash") count as one typo.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a: string, b: string) => (a || b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 0);

/** 0..1 similarity between two names, ignoring case, punctuation, word order and company suffixes. */
export function nameScore(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = na.split(" "), tb = nb.split(" ");
  const sortedA = [...ta].sort().join(""), sortedB = [...tb].sort().join("");
  if (sortedA === sortedB) return 0.97; // same words, different order: "Dela Cruz Juan" vs "Juan Dela Cruz"
  const ca = ta.join(""), cb = tb.join("");
  const setA = new Set(ta), setB = new Set(tb);
  const inter = [...setA].filter((w) => setB.has(w)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  // One name is the other plus extra words: "Meralco" vs "Meralco Makati Branch".
  const short = ca.length < cb.length ? ca : cb, long = ca.length < cb.length ? cb : ca;
  const contains = short.length >= 4 && long.includes(short) ? 0.8 + 0.15 * (short.length / long.length) : 0;
  // Fuzzy word match catches typos inside words: "Mercury Drgu" vs "Mercury Drug".
  const fuzzyHits = ta.filter((w) => tb.some((v) => ratio(w, v) >= 0.8)).length;
  const fuzzyWords = fuzzyHits / Math.max(ta.length, tb.length);
  return Math.max(ratio(ca, cb), ratio(sortedA, sortedB), jaccard, contains, fuzzyWords * 0.95);
}

/** For "did you mean" while typing: how well every typed word matches some word of the label, allowing typos. */
export function typeaheadScore(query: string, label: string): number {
  const q = normalize(query).split(" ").filter(Boolean), l = normalize(label).split(" ").filter(Boolean);
  if (!q.length || !l.length) return 0;
  const per = q.map((w) => Math.max(...l.map((v) => (v.startsWith(w) ? 1 : ratio(w, v.slice(0, Math.max(w.length, Math.min(v.length, w.length + 1))))))));
  return per.reduce((a, b) => a + b, 0) / q.length;
}

export const SIMILAR_THRESHOLD = 0.62;

/** Records that look like the one being added, best first. */
export function findSimilar(probe: Probe, candidates: Candidate[], limit = 5): SimilarMatch[] {
  const out: SimilarMatch[] = [];
  const pTin = digits(probe.tin).slice(0, 9);
  const pAcct = digits(probe.accountNumber);
  const pEmail = (probe.email ?? "").trim().toLowerCase();
  const pCode = (probe.code ?? "").trim().toUpperCase();
  for (const c of candidates) {
    let score = 0, reason = "";
    const take = (s: number, r: string) => { if (s > score) { score = s; reason = r; } };
    if (pCode && c.code.toUpperCase() === pCode) take(1, "Same code");
    if (pTin.length === 9 && digits(c.tin).slice(0, 9) === pTin) take(1, "Same TIN");
    if (pAcct.length >= 6 && digits(c.accountNumber) === pAcct) take(1, "Same account number");
    if (pEmail && (c.email ?? "").trim().toLowerCase() === pEmail) take(0.95, "Same email");
    if (probe.name.trim()) {
      const n = nameScore(probe.name, c.label);
      take(n, n >= 0.999 ? "Same name" : "Similar name");
      // People often type the code instead of the name ("6130" or "USD").
      if (c.code.toUpperCase() === probe.name.trim().toUpperCase()) take(1, "Same code");
    }
    if (score >= SIMILAR_THRESHOLD) out.push({ id: c.id, code: c.code, label: c.label, score: Math.round(score * 100) / 100, reason });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Next code in the same pattern as the existing ones, e.g. V-0007 after V-0006. */
export function nextCode(codes: string[]): string | null {
  let best: { prefix: string; n: number; width: number } | null = null;
  const counts = new Map<string, number>();
  const parsed = codes.map((c) => c.match(/^(.*?)(\d+)$/)).filter(Boolean) as RegExpMatchArray[];
  for (const m of parsed) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (prefix === undefined) return null;
  for (const m of parsed) {
    if (m[1] !== prefix) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { prefix, n, width: m[2].length };
  }
  return best ? best.prefix + String(best.n + 1).padStart(best.width, "0") : null;
}

/** How the typed text maps onto the new record's fields. */
export function prefillFromText(kind: MasterKind, text: string): Record<string, string> {
  const t = text.trim();
  if (!t) return {};
  if (kind === "employees") {
    if (t.includes(",")) {
      const [last, first] = t.split(",").map((s) => s.trim());
      return { lastName: last, firstName: first ?? "" };
    }
    const parts = t.split(/\s+/);
    if (parts.length === 1) return { lastName: t };
    // Filipino surnames often have particles: "Juan dela Cruz", "Ana de los Santos".
    const particle = parts.findIndex((p, i) => i > 0 && /^(de|dela|del|delos|de\.|san|santa|sta\.?|sto\.?)$/i.test(p));
    const cut = particle > 0 ? particle : parts.length - 1;
    return { firstName: parts.slice(0, cut).join(" "), lastName: parts.slice(cut).join(" ") };
  }
  if (kind === "currencies" && /^[a-z]{3}$/i.test(t)) return { code: t.toUpperCase() };
  if (kind === "accounts" && /^\d[\d-]*$/.test(t)) return { code: t };
  return { name: t };
}
