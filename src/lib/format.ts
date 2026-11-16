export const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);
export const firstOfYear = () => `${new Date().getUTCFullYear()}-01-01`;
export function parseDateParam(v: string | string[] | undefined, fallback: string) {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}
