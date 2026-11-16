"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { endSession, hashPassword, startSession, verifyPassword } from "@/lib/auth";
import { provisionOrganization } from "@/lib/org";

export type FormState = { errors?: string[] } | undefined;

export async function login(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) return { errors: ["Wrong email or password"] };
  const first = await prisma.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  await startSession(user.id, first?.organizationId ?? null);
  redirect("/dashboard");
}

const RegisterSchema = z.object({
  company: z.string().trim().min(2, "Enter your company name"),
  tin: z.string().trim().optional(),
  name: z.string().trim().min(2, "Enter your name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function register(_: FormState, fd: FormData): Promise<FormState> {
  const p = RegisterSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
  if (await prisma.user.findUnique({ where: { email: p.data.email } })) return { errors: ["That email is already registered. Sign in instead."] };
  const user = await prisma.user.create({ data: { email: p.data.email, name: p.data.name, passwordHash: await hashPassword(p.data.password) } });
  const org = await provisionOrganization({ name: p.data.company, tin: p.data.tin, ownerUserId: user.id });
  await startSession(user.id, org.id);
  redirect("/dashboard");
}

export async function logout() {
  await endSession();
  redirect("/login");
}
