import type { User } from "./api";

type Role = User["role"];

// Shared by role selection, the people table's help, and the role reference.
export const roles = {
  viewer: ["Viewer", "Sees devices, pipelines, deployments and activity."],
  editor: [
    "Editor",
    "Creates and changes pipeline drafts. Doesn't publish or deploy.",
  ],
  operator: [
    "Operator",
    "Publishes and deploys, and manages devices, groups, agent settings and enrollment. Doesn't edit drafts.",
  ],
  admin: [
    "Administrator",
    "Everything, including managing people and recovering device identities.",
  ],
} as const satisfies Record<Role, readonly [string, string]>;

export const roleOrder = ["viewer", "editor", "operator", "admin"] as const;

/**
 * What each role can do, as enforced by the server. Editing and publishing
 * stay separate so every published change has a second pair of eyes;
 * administrators can do both.
 */
export const capabilities = [
  {
    id: "view",
    label: "View devices, pipelines and activity",
    roles: ["viewer", "editor", "operator", "admin"],
  },
  {
    id: "edit",
    label: "Create and edit pipeline drafts",
    roles: ["editor", "admin"],
  },
  {
    id: "operate",
    label: "Publish and deploy pipelines",
    roles: ["operator", "admin"],
  },
  {
    id: "fleet",
    label: "Manage devices, groups, agent settings and enrollment",
    roles: ["operator", "admin"],
  },
  {
    id: "people",
    label: "Manage people and recover device identities",
    roles: ["admin"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  roles: readonly Role[];
}[];

export function roleCan(
  role: Role,
  capability: (typeof capabilities)[number]["id"],
) {
  return (
    (
      capabilities.find((entry) => entry.id === capability)?.roles as
        readonly Role[] | undefined
    )?.includes(role) ?? false
  );
}

/** The roles that include a permission, for "needs the Operator role" notes. */
export function rolesFor(permission: "edit" | "operate" | "admin"): string {
  if (permission === "admin") return roles.admin[0];
  return `${roles[permission === "edit" ? "editor" : "operator"][0]} or ${roles.admin[0]}`;
}
