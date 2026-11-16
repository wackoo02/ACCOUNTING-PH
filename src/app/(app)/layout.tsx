import { Logo } from "@/components/Logo";
import { Suspense, type ReactNode } from "react";
import { requireCtx } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/permissions";
import { navFor, COMING_NEXT } from "@/lib/nav";
import { SideNav } from "@/components/SideNav";
import { ModuleHeader } from "@/components/ModuleHeader";
import { RouteTransition } from "@/components/RouteTransition";
import { Icon } from "@/components/Icon";
import { logout } from "../(auth)/actions";
import { changeCompany } from "./actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx();
  const sections = navFor(ctx.role);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Logo dark /></div>
        {ctx.memberships.length > 1 ? (
          <form action={changeCompany} style={{ margin: "0 8px 8px" }}>
            <select name="organizationId" defaultValue={ctx.org.id}>
              {ctx.memberships.map((m) => <option key={m.organizationId} value={m.organizationId}>{m.name}</option>)}
            </select>
            <button className="secondary" style={{ marginTop: 6, width: "100%" }}>Switch company</button>
          </form>
        ) : (
          <div style={{ margin: "0 10px 8px", color: "#fff" }}>{ctx.org.name}</div>
        )}
        <div style={{ margin: "0 10px", fontSize: 12 }}>{ctx.user.name} · {ROLE_LABELS[ctx.role]}</div>
        <nav>
          <Suspense fallback={null}>
            <SideNav sections={sections} comingNext={COMING_NEXT} />
          </Suspense>
          <form action={logout}><button className="link signout"><Icon name="signout" size={17} /><span>Sign out</span></button></form>
        </nav>
      </aside>
      <main className="main">
        <Suspense fallback={null}><ModuleHeader sections={sections} /></Suspense>
        <RouteTransition>{children}</RouteTransition>
      </main>
    </div>
  );
}
