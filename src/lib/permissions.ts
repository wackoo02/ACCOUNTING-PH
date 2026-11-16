import type { Role } from "@prisma/client";

export type Permission =
  | "masters.manage" // chart of accounts + all master lists (admins only)
  | "journal.create"
  | "journal.post"
  | "journal.void"
  | "period.close"
  | "reports.view"
  | "users.manage"
  | "org.manage"
  | "pettycash.capture" // record petty cash receipts from the mobile app
  | "pettycash.approve" // approve petty cash vouchers and purchase orders
  | "pettycash.replenish"; // create replenishment batches

const MATRIX: Record<Role, Permission[]> = {
  OWNER: ["masters.manage", "journal.create", "journal.post", "journal.void", "period.close", "reports.view", "users.manage", "org.manage", "pettycash.capture", "pettycash.approve", "pettycash.replenish"],
  ADMIN: ["masters.manage", "journal.create", "journal.post", "journal.void", "period.close", "reports.view", "users.manage", "org.manage", "pettycash.capture", "pettycash.approve", "pettycash.replenish"],
  ACCOUNTANT: ["journal.create", "journal.post", "journal.void", "period.close", "reports.view", "pettycash.capture", "pettycash.replenish"],
  BOOKKEEPER: ["journal.create", "reports.view", "pettycash.capture", "pettycash.replenish"],
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
