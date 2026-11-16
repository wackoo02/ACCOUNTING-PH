import Link from "next/link";

/** "Customize" button on a standard report: opens the same report in the report builder. */
export function CustomizeLink({ template, from, to, qs = "" }: { template: string; from?: string; to?: string; qs?: string }) {
  const p = new URLSearchParams({ template, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  return <Link className="btn secondary noprint" href={`/reports/custom/new?${p.toString()}${qs}`}>Customize</Link>;
}
