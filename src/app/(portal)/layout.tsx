import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logout } from "../(auth)/actions";

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const ctx = await requireCtx(undefined, { portal: true });
  const me = await prisma.employee.findFirst({ where: { organizationId: ctx.org.id, userId: ctx.user.id } });
  const manages = me ? (await prisma.employee.count({ where: { organizationId: ctx.org.id, managerId: me.id } })) > 0 : false;
  return (
    <div className="portal">
      <header className="portal-top">
        <Logo />
        <nav className="row" style={{ gap: 14, flex: 0, flexWrap: "nowrap", alignItems: "center" }}>
          <Link href="/portal">My time and requests</Link>
          {manages && <Link href="/portal/team">My team</Link>}
          {ctx.role !== "EMPLOYEE" && <Link href="/dashboard">Back to Veritus ERP</Link>}
          <span className="muted" style={{ whiteSpace: "nowrap" }}>{ctx.user.name} · {ctx.org.name}</span>
          <form action={logout}><button className="link">Sign out</button></form>
        </nav>
      </header>
      <main className="portal-main">{children}</main>
    </div>
  );
}
