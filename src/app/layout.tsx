import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Veritus ERP", description: "Intelligent. Integrated. Compliant. Multi-company accounting for the Philippines." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
