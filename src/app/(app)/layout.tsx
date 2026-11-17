import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Suspense, type ReactNode } from "react";
import { requireCtx } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions";
import { navFor, COMING_NEXT } from "@/lib/nav";
import { notifications, type Alert } from "@/lib/dashboard";
import { SideNav } from "@/components/SideNav";
import { TopBar } from "@/components/TopBar";
import { ModuleHeader } from "@/components/ModuleHeader";
import { RouteTransition } from "@/components/RouteTransition";
import { logout } from "../(auth)/actions";
import { changeCompany } from "./actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx();
  const sections = navFor(ctx.role);
  // The bell must never take a page down: if a query fails, show no notifications.
  const notes: Alert[] = await notifications(ctx.org.id, ctx.role).catch((e) => { console.error("notifications", e); return []; });
  return (
    <div className="shell">
      <aside className="side">
        <Link href="/dashboard" className="brand" aria-label="Veritus ERP home"><Logo dark tagline /></Link>
        <nav>
          <Suspense fallback={null}>
            <SideNav sections={sections} comingNext={COMING_NEXT} />
          </Suspense>
        </nav>
      </aside>
      <div className="main-wrap">
        <TopBar
          sections={sections}
          user={{ name: ctx.user.name, email: ctx.user.email, role: ROLE_LABELS[ctx.role] }}
          org={ctx.org}
          memberships={ctx.memberships.map((m) => ({ organizationId: m.organizationId, name: m.name }))}
          notes={notes}
          changeCompany={changeCompany}
          logout={logout}
        />
        <main className="main">
          <Suspense fallback={null}><ModuleHeader sections={sections} /></Suspense>
          <RouteTransition>{children}</RouteTransition>
        </main>
        <footer className="app-foot noprint">
          <span>Veritus ERP · Intelligent. Integrated. Compliant.</span>
          <span>PFRS / IFRS · BIR-ready · Secure</span>
        </footer>
      </div>
    </div>
  );
}
