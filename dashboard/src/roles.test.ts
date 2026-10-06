import { describe, expect, it } from "vitest";
import { can, setCSRF, type User } from "./api";
import { capabilities, roleCan, roleOrder, rolesFor } from "./roles";

const person = (role: User["role"]): User => ({
  id: "11111111-1111-4111-8111-111111111111",
  email: "someone@example.test",
  name: "Someone",
  role,
  enabled: true,
  revision: 1,
});

describe("role capabilities", () => {
  it("keeps editing and publishing separate; administrators do both", () => {
    expect(roleCan("editor", "edit")).toBe(true);
    expect(roleCan("editor", "operate")).toBe(false);
    expect(roleCan("operator", "operate")).toBe(true);
    expect(roleCan("operator", "edit")).toBe(false);
    for (const capability of capabilities)
      expect(roleCan("admin", capability.id)).toBe(true);
    expect(
      capabilities.filter((capability) => roleCan("viewer", capability.id)),
    ).toHaveLength(1);
  });

  it("matches the dashboard's permission checks for every role", () => {
    setCSRF("synthetic");
    try {
      for (const role of roleOrder) {
        const user = person(role);
        expect(roleCan(role, "edit")).toBe(can(user, "edit"));
        expect(roleCan(role, "operate")).toBe(can(user, "operate"));
        expect(roleCan(role, "fleet")).toBe(can(user, "operate"));
        expect(roleCan(role, "people")).toBe(can(user, "admin"));
      }
    } finally {
      setCSRF("");
    }
  });

  it("names who can do something for permission notes", () => {
    expect(rolesFor("edit")).toBe("Editor or Administrator");
    expect(rolesFor("operate")).toBe("Operator or Administrator");
    expect(rolesFor("admin")).toBe("Administrator");
  });
});
