import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { can, type Permission } from "./permissions";

const COOKIE = "ph_session";
const SESSION_DAYS = 7;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}
export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function startSession(userId: string, activeOrganizationId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await prisma.session.create({ data: { id: hashToken(token), userId, activeOrganizationId, expiresAt } });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  jar.delete(COOKIE);
}

async function currentSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) return null;
  return s;
}

export type Ctx = {
  sessionId: string;
  user: { id: string; name: string; email: string };
  org: { id: string; name: string };
  role: import("@prisma/client").Role;
  memberships: { organizationId: string; name: string; role: import("@prisma/client").Role }[];
};

/** Resolve the signed-in user + active company. Redirects to /login if missing. */
export async function requireCtx(permission?: Permission, opts: { portal?: boolean } = {}): Promise<Ctx> {
  const s = await currentSession();
  if (!s) redirect("/login");
  const memberships = await prisma.membership.findMany({
    where: { userId: s.userId },
    include: { organization: true },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) redirect("/login?error=nocompany");
  const m = memberships.find((x) => x.organizationId === s.activeOrganizationId) ?? memberships[0];
  // Employee logins only reach the self-service portal.
  if (m.role === "EMPLOYEE" && !opts.portal) redirect("/portal");
  if (permission && !can(m.role, permission)) {
    throw new Error("You do not have permission to do this. Ask your company's owner or administrator.");
  }
  return {
    sessionId: s.id,
    user: { id: s.user.id, name: s.user.name, email: s.user.email },
    org: { id: m.organizationId, name: m.organization.name },
    role: m.role,
    memberships: memberships.map((x) => ({ organizationId: x.organizationId, name: x.organization.name, role: x.role })),
  };
}

export async function switchOrganization(organizationId: string) {
  const s = await currentSession();
  if (!s) redirect("/login");
  const m = await prisma.membership.findUnique({ where: { userId_organizationId: { userId: s.userId, organizationId } } });
  if (!m) throw new Error("Not a member of that company");
  await prisma.session.update({ where: { id: s.id }, data: { activeOrganizationId: organizationId } });
}
