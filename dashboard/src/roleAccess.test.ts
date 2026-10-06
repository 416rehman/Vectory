import { afterEach, describe, expect, it } from "vitest";
import { can, invalidateSession, setCSRF, type User } from "./api";
import { roleAllows, type RolePermission } from "./roleAccess";

const permissions: RolePermission[] = ["edit", "operate", "admin"];
const expected: Record<User["role"], RolePermission[]> = {
  viewer: [],
  editor: ["edit"],
  operator: ["operate"],
  admin: ["edit", "operate", "admin"],
};
const user = (role: User["role"]) => ({ role }) as User;

describe("roleAllows", () => {
  afterEach(() => setCSRF("synthetic-csrf"));

  it("grants each role exactly its permissions", () => {
    for (const [role, allowed] of Object.entries(expected))
      for (const permission of permissions)
        expect(
          roleAllows(user(role as User["role"]), permission),
          `${role} ${permission}`,
        ).toBe(allowed.includes(permission));
  });

  it("matches can() while the session is live", () => {
    setCSRF("synthetic-csrf");
    for (const role of Object.keys(expected) as User["role"][])
      for (const permission of permissions)
        expect(roleAllows(user(role), permission)).toBe(
          can(user(role), permission),
        );
  });

  it("keeps answering by role after the session ends, unlike can()", () => {
    setCSRF("synthetic-csrf");
    invalidateSession();
    expect(can(user("admin"), "operate")).toBe(false);
    expect(roleAllows(user("admin"), "operate")).toBe(true);
    expect(roleAllows(user("viewer"), "operate")).toBe(false);
  });
});
