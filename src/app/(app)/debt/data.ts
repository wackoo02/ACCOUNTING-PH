import { prisma } from "@/lib/db";

export async function loanFormData(organizationId: string) {
  const [accounts, banks, vendors] = await Promise.all([
    prisma.account.findMany({ where: { organizationId }, orderBy: { code: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId, isActive: true, kind: { in: ["CURRENT", "SAVINGS"] } }, orderBy: { code: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
  ]);
  return { accounts, banks, vendors };
}
