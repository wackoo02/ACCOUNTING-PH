import type { Role } from "@prisma/client";

export type Permission =
  | "masters.manage" // chart of accounts + all master lists (admins only)
  | "journal.create"
  | "journal.post"
  | "journal.void"
  | "period.close"
  | "reports.view"
  | "users.manage"
  | "org.manage";

const MATRIX: Record<Role, Permission[]> = {
  OWNER: ["masters.manage", "journal.create", "journal.post", "journal.void", "period.close", "reports.view", "users.manage", "org.manage"],
  ADMIN: ["masters.manage", "journal.create", "journal.post", "journal.void", "period.close", "reports.view", "users.manage", "org.manage"],
  ACCOUNTANT: ["journal.create", "journal.post", "journal.void", "period.close", "reports.view"],
  BOOKKEEPER: ["journal.create", "reports.view"],
  VIEWER: ["reports.view"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  ACCOUNTANT: "Accountant",
  BOOKKEEPER: "Bookkeeper",
  VIEWER: "Viewer (read-only)",
};
