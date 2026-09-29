import { describe, expect, it } from "vitest";
import { findSteps } from "./CanvasFind";

const node = (
  id: string,
  type: string,
  kind: "sources" | "transforms" | "sinks",
) => ({ id, data: { kind, component: { type } } });
const nodes = [
  node("nginx_access", "file", "sources"),
  node("parse", "remap", "transforms"),
  node("parse_errors", "remap", "transforms"),
  node("by_status", "route", "transforms"),
  node("archive", "aws_s3", "sinks"),
];

describe("find a step", () => {
  it("ranks an exact ID, then a prefix, then a partial ID, then the name or type", () => {
    expect(findSteps(nodes, "parse").map((step) => step.id)).toEqual([
      "parse",
      "parse_errors",
    ]);
    expect(findSteps(nodes, "status").map((step) => step.id)).toEqual([
      "by_status",
    ]);
    expect(findSteps(nodes, "s3").map((step) => step.id)).toEqual(["archive"]);
    expect(findSteps(nodes, "amazon").map((step) => step.id)).toEqual([
      "archive",
    ]);
    expect(findSteps(nodes, "remap").map((step) => step.id)).toEqual([
      "parse",
      "parse_errors",
    ]);
  });

  it("lists every step, alphabetically, for an empty query and none for a miss", () => {
    expect(findSteps(nodes, "").map((step) => step.id)).toEqual([
      "archive",
      "by_status",
      "nginx_access",
      "parse",
      "parse_errors",
    ]);
    expect(findSteps(nodes, "zzz")).toEqual([]);
  });

  it("names each result with the shared label", () => {
    expect(findSteps(nodes, "nginx")[0]).toMatchObject({
      id: "nginx_access",
      title: "Log files",
      type: "file",
    });
  });
});
