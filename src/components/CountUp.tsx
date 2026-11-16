"use client";
import { useEffect, useRef, useState } from "react";

/** Animates the number inside a formatted string (e.g. "₱ 589,000.00", "42.25", "59.6%") from 0. */
export function CountUp({ text, ms = 900 }: { text: string; ms?: number }) {
  const m = text.match(/-?[\d,]+(\.\d+)?/);
  const [shown, setShown] = useState(text);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!m) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const target = Number(m[0].replace(/,/g, ""));
    const decimals = m[1] ? m[1].length - 1 : 0;
    const grouped = m[0].includes(",");
    const fmt = (v: number) =>
      grouped ? v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(text.replace(m[0], fmt(target * eased)));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return <>{shown}</>;
}
