import type { ReactNode } from "react";

// Bare pages shown inside the "add new record" pop-up from any form.
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return <div className="embed">{children}</div>;
}
