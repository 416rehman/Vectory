import type { User } from "./api";

export type RolePermission = "edit" | "operate" | "admin";

/**
 * What the account's role allows, whether or not the session is live.
 *
 * `can()` answers false while a session has ended so actions are not
 * offered; deciding which page, panel or dialog to mount with it would
 * unmount work in progress during a re-sign-in. Mount by role, and let
 * `can()` and the request layer decide whether an action runs.
 */
export function roleAllows(
  user: Pick<User, "role">,
  permission: RolePermission,
): boolean {
  if (permission === "admin") return user.role === "admin";
  if (permission === "operate")
    return user.role === "operator" || user.role === "admin";
  return user.role === "editor" || user.role === "admin";
}
