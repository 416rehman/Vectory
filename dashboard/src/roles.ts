import type { User } from "./api";

// Shared by role selection, the people table's help, and the role reference.
export const roles = {
  viewer: [
    "Viewer",
    "View devices, pipelines, deployments and activity; export audit history.",
  ],
  editor: [
    "Editor",
    "Viewer access, plus create, edit, validate and organize pipeline drafts. Cannot publish or deploy.",
  ],
  operator: [
    "Operator",
    "Viewer access, plus publish and deploy pipelines and manage schedules, groups, agent settings, enrollment tokens and device access. Cannot edit drafts.",
  ],
  admin: [
    "Administrator",
    "All permissions, including managing people and recovering device identities.",
  ],
} as const satisfies Record<User["role"], readonly [string, string]>;

export const roleOrder = ["viewer", "editor", "operator", "admin"] as const;
