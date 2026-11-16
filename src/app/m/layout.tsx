import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./mobile.css";

export const metadata: Metadata = {
  title: "Veritus Mobility",
  description: "Veritus ERP on your phone: receipts, trips, deliveries, sales invoices and asset audits.",
  appleWebApp: { capable: true, title: "Veritus", statusBarStyle: "black-translucent" },
  icons: { apple: "/apple-touch-icon.png", icon: "/icon-192.png" },
};
export const viewport: Viewport = { themeColor: "#1E1338", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function MobileLayout({ children }: { children: ReactNode }) {
  return <div className="vm-root">{children}</div>;
}
