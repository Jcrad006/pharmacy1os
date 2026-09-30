export const roles = [
  "ADMIN",
  "PHARMACIST",
  "TECHNICIAN",
  "INTERN",
  "CASHIER",
  "AUDITOR",
] as const;

export type Role = (typeof roles)[number];

export const permissions = [
  "patient:read",
  "patient:write",
  "prescription:read",
  "prescription:enter",
  "prescription:process",
  "prescription:verify",
  "prescription:sell",
  "inventory:read",
  "inventory:write",
  "user:manage",
  "audit:read",
] as const;

export type Permission = (typeof permissions)[number];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  ADMIN: permissions,
  PHARMACIST: [
    "patient:read",
    "patient:write",
    "prescription:read",
    "prescription:enter",
    "prescription:process",
    "prescription:verify",
    "prescription:sell",
    "inventory:read",
    "inventory:write",
    "audit:read",
  ],
  TECHNICIAN: [
    "patient:read",
    "patient:write",
    "prescription:read",
    "prescription:enter",
    "prescription:process",
    "prescription:sell",
    "inventory:read",
    "inventory:write",
  ],
  INTERN: [
    "patient:read",
    "patient:write",
    "prescription:read",
    "prescription:enter",
    "prescription:process",
    "inventory:read",
  ],
  CASHIER: ["patient:read", "prescription:read", "prescription:sell"],
  AUDITOR: ["audit:read"],
};

export function roleHasPermission(role: Role, permission: Permission) {
  return rolePermissions[role].includes(permission);
}
