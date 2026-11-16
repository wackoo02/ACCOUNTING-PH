"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Re-mounts on route change so the page plays its entry animation; also flashes the top progress bar. */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="route-enter">
      <div className="route-bar" aria-hidden="true" />
      {children}
    </div>
  );
}
