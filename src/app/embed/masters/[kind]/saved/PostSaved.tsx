"use client";
import { useEffect } from "react";

export function PostSaved({ record }: { record: Record<string, unknown> }) {
  useEffect(() => {
    window.parent?.postMessage({ source: "veritus-master", type: "saved", record }, window.location.origin);
  }, [record]);
  return <div className="notice">Saved {String(record.code)} · {String(record.label)}. Returning to your entry…</div>;
}
