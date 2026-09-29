import { describe, expect, it } from "vitest";
import {
  deviceName,
  labelKey,
  labelValue,
  maxLabels,
  maxPreapprovedNames,
  parseLabels,
  parsePreapprovedNames,
  sameScope,
  scopeText,
} from "./enrollmentScope";

describe("enrollment token scope", () => {
  it("normalizes names exactly as enrollment does", () => {
    expect(deviceName(" Edge-01 ")).toBe("edge-01");
    expect(deviceName("web_2.eu")).toBe("web_2.eu");
    for (const bad of [
      "",
      "   ",
      "-edge",
      ".edge",
      "edge 01",
      "edge/01",
      "édge",
      "a\0b",
      // Kelvin sign: JavaScript would lowercase it to "k"; the server refuses it.
      "Kelvin",
      // The server's trim keeps a byte-order mark, then refuses the name.
      "﻿edge",
    ])
      expect(deviceName(bad), JSON.stringify(bad)).toBeNull();
    expect(deviceName("a".repeat(100))).toBe("a".repeat(100));
    expect(deviceName("a".repeat(101))).toBeNull();
  });

  it("normalizes label keys, keeps values and bounds both", () => {
    expect(labelKey(" Site ")).toBe("site");
    expect(labelKey("team.platform-core_2")).toBe("team.platform-core_2");
    for (const bad of ["", "-site", "site name", "sité", "k".repeat(64)])
      expect(labelKey(bad), bad).toBeNull();
    expect(labelValue("  São Paulo ")).toBe("São Paulo");
    expect(labelValue("a=b")).toBe("a=b");
    for (const bad of [
      "",
      "  ",
      "line\u0085break",
      "tab\there",
      "v".repeat(129),
    ])
      expect(labelValue(bad), JSON.stringify(bad)).toBeNull();
    expect(labelValue("é".repeat(128))).toBe("é".repeat(128));
  });

  it("reads preapproved names from lines, commas or spaces", () => {
    expect(parsePreapprovedNames("")).toEqual({ value: null, error: "" });
    expect(parsePreapprovedNames(" \n ")).toEqual({ value: null, error: "" });
    expect(
      parsePreapprovedNames("Lab-01, lab-02\nlab-03  LAB-01", "lab-"),
    ).toEqual({ value: ["lab-01", "lab-02", "lab-03"], error: "" });
    expect(parsePreapprovedNames("lab-01 db-01", "lab-").error).toBe(
      "db-01 doesn't start with lab-, so it could never enroll.",
    );
    expect(parsePreapprovedNames("lab-01 -bad").error).toMatch(
      /^-bad can't be a device name/,
    );
    const many = Array.from(
      { length: maxPreapprovedNames + 1 },
      (_, index) => `host-${index}`,
    );
    expect(parsePreapprovedNames(many.slice(1).join("\n")).value).toHaveLength(
      maxPreapprovedNames,
    );
    expect(parsePreapprovedNames(many.join("\n")).error).toBe(
      `List at most ${maxPreapprovedNames} names; this has ${maxPreapprovedNames + 1}.`,
    );
  });

  it("reads labels one key=value per line", () => {
    expect(parseLabels("")).toEqual({ value: null, error: "" });
    expect(parseLabels("Site = Berlin\n\nrack=r12=a\r\n")).toEqual({
      value: { site: "Berlin", rack: "r12=a" },
      error: "",
    });
    expect(parseLabels("site").error).toMatch(/key=value/);
    expect(parseLabels("bad key=x").error).toMatch(
      /^bad key can't be a label key/,
    );
    expect(parseLabels("site=").error).toBe(
      "Give site a value of 1 to 128 characters.",
    );
    expect(parseLabels("site=a\nSITE=b").error).toBe(
      "site appears more than once.",
    );
    const nine = Array.from({ length: maxLabels + 1 }, (_, n) => `k${n}=v`);
    expect(parseLabels(nine.join("\n")).error).toBe(
      `Use at most ${maxLabels} labels.`,
    );
  });

  it("compares a receipt's scope with the request regardless of label order", () => {
    expect(sameScope({}, { allowed_names: null, labels: null })).toBe(true);
    expect(sameScope({ labels: {} }, {})).toBe(true);
    expect(
      sameScope(
        { allowed_names: ["a", "b"], labels: { site: "x", rack: "1" } },
        { allowed_names: ["a", "b"], labels: { rack: "1", site: "x" } },
      ),
    ).toBe(true);
    expect(sameScope({ allowed_names: ["a"] }, { allowed_names: ["b"] })).toBe(
      false,
    );
    expect(sameScope({ labels: { site: "x" } }, {})).toBe(false);
  });

  it("describes what a token may enroll", () => {
    expect(scopeText({})).toBe("Any unique device name");
    expect(scopeText({ name_prefix: "lab-" })).toBe("Names starting with lab-");
    expect(scopeText({ name_prefix: "lab-", allowed_names: ["lab-01"] })).toBe(
      "Only lab-01",
    );
    expect(
      scopeText({
        allowed_names: ["a", "b"],
        labels: { site: "berlin", rack: "r12" },
      }),
    ).toBe("2 preapproved names · labels site=berlin, rack=r12");
    expect(scopeText({ recovery_name: "edge-01", allowed_names: ["x"] })).toBe(
      "Recovery for edge-01",
    );
  });
});
