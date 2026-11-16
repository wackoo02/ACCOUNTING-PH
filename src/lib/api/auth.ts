// Bearer-token auth for the mobile app API. Tokens reuse the Session table (hashed at rest),
// so signing out or deleting a user ends their phone sessions too.
import { createHash, randomBytes } from "crypto";
import type { Role } from "@prisma/client";
import { prisma } from "../db";
import { can, type Permission } from "../permissions";

const TOKEN_DAYS = 30;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class ApiError extends Error {
  constructor(public status: number, public errors: string[]) {
    super(errors.join("; "));
  }
}

export type ApiCtx = {
  sessionId: string;
  user: { id: string; name: string; email: string };
  org: { id: string; name: string };
  role: Role;
  approvalLimit: string | null;
};

export async function issueToken(userId: string, organizationId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_DAYS * 864e5);
  await prisma.session.create({ data: { id: hashToken(token), userId, activeOrganizationId: organizationId, expiresAt } });
  return { token, expiresAt };
}

export async function revokeToken(req: Request) {
  const t = bearer(req);
  if (t) await prisma.session.deleteMany({ where: { id: hashToken(t) } });
}

function bearer(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the caller. The company comes from the X-Company-Id header, else the token's company. */
export async function requireApiCtx(req: Request, permission?: Permission): Promise<ApiCtx> {
  const token = bearer(req);
  if (!token) throw new ApiError(401, ["Sign in first"]);
  const s = await prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) throw new ApiError(401, ["Your session has expired. Sign in again."]);
  const wanted = req.headers.get("x-company-id") || s.activeOrganizationId;
  const memberships = await prisma.membership.findMany({ where: { userId: s.userId }, include: { organization: true }, orderBy: { createdAt: "asc" } });
  const m = (wanted ? memberships.find((x) => x.organizationId === wanted) : null) ?? (wanted ? null : memberships[0]);
  if (!m) throw new ApiError(403, ["You are not a member of that company"]);
  if (permission && !can(m.role, permission)) throw new ApiError(403, ["You do not have permission to do this. Ask your company's owner or administrator."]);
  return {
    sessionId: s.id,
    user: { id: s.user.id, name: s.user.name, email: s.user.email },
    org: { id: m.organizationId, name: m.organization.name },
    role: m.role,
    approvalLimit: m.approvalLimit?.toString() ?? null,
  };
}
