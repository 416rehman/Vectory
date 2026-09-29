import { describe, expect, it } from "vitest";
import {
  deviceReach,
  groupChanges,
  sectionCount,
  programDiff,
  reachLabel,
  reviewChanges,
} from "./publishReview";

const published = {
  sources: { nginx: { type: "file", include: ["/var/log/nginx/*.log"] } },
  transforms: {
    parse: {
      type: "remap",
      inputs: ["nginx"],
      source: '. = parse_nginx_log!(.message, "combined")\n.env = "prod"',
    },
    by_status: {
      type: "route",
      inputs: ["parse"],
      route: { errors: ".status >= 500" },
    },
  },
  sinks: {
    loki: { type: "loki", inputs: ["by_status.errors"], endpoint: "http://a" },
  },
};

describe("publish review", () => {
  it("ignores key order, the way the server returns a version", () => {
    const draft = {
      sources: { nginx: { type: "file", include: ["/var/log/a.log"] } },
      transforms: {
        parse: { type: "remap", inputs: ["nginx"], source: ".a = 1" },
      },
      sinks: {
        loki: {
          type: "loki",
          inputs: ["parse", "nginx"],
          labels: { app: "web", env: "prod" },
        },
      },
    };
    const server = {
      sinks: {
        loki: {
          labels: { env: "prod", app: "web" },
          inputs: ["nginx", "parse"],
          type: "loki",
        },
      },
      sources: { nginx: { include: ["/var/log/a.log"], type: "file" } },
      transforms: {
        parse: { source: ".a = 1", inputs: ["nginx"], type: "remap" },
      },
    };
    expect(reviewChanges(server, draft).components).toEqual([]);
    // Order inside other lists still matters.
    const reordered = structuredClone(draft) as any;
    reordered.sources.nginx.include = ["/var/log/b.log", "/var/log/a.log"];
    server.sources.nginx.include = ["/var/log/a.log", "/var/log/b.log"];
    expect(reviewChanges(server, reordered).components).toMatchObject([
      { id: "nginx", options: ["include"] },
    ]);
  });

  it("lists steps from source to sink", () => {
    const draft = {
      transforms: {
        by_status: { type: "route", inputs: ["parse"], route: { a: "true" } },
        parse: { type: "remap", inputs: ["nginx"], source: "." },
      },
      sinks: { archive: { type: "aws_s3", inputs: ["by_status.a"] } },
      sources: { nginx: { type: "file" } },
    };
    expect(reviewChanges(null, draft).components.map((c) => c.id)).toEqual([
      "nginx",
      "parse",
      "by_status",
      "archive",
    ]);
  });

  it("lists added, removed and changed steps with program and option changes", () => {
    const draft = structuredClone(published) as any;
    draft.transforms.parse.source =
      '. = parse_nginx_log!(.message, "combined")\n.env = "staging"';
    draft.transforms.by_status.route.errors = "((.status >= 500) ?? false)";
    draft.sinks.loki.endpoint = "http://b";
    draft.sinks.loki.inputs = ["parse"];
    draft.sinks.archive = { type: "aws_s3", inputs: ["parse"], bucket: "x" };
    delete draft.sources.nginx;
    draft.sources.journal = { type: "journald" };
    draft.timezone = "UTC";
    const review = reviewChanges(published, draft);
    const byId = Object.fromEntries(review.components.map((c) => [c.id, c]));
    expect(byId.parse).toMatchObject({
      change: "changed",
      options: [],
      programs: [{ path: "source", label: "VRL program" }],
      rewired: false,
    });
    expect(byId.by_status.programs[0]).toMatchObject({
      path: "route.errors",
      label: "Route errors",
      before: ".status >= 500",
      after: "((.status >= 500) ?? false)",
    });
    expect(byId.loki).toMatchObject({ options: ["endpoint"], rewired: true });
    expect(byId.archive).toMatchObject({ change: "added", type: "aws_s3" });
    expect(byId.nginx.change).toBe("removed");
    expect(byId.journal.change).toBe("added");
    expect(review.settings).toEqual(["timezone"]);
    expect(review.tests).toBeNull();
    expect(reviewChanges(published, published).components).toEqual([]);
    // A first version shows every step as added.
    expect(
      reviewChanges(null, published).components.every(
        (component) => component.change === "added",
      ),
    ).toBe(true);
  });

  it("diffs programs by line and folds long unchanged runs", () => {
    const before = Array.from({ length: 12 }, (_, i) => `.f${i} = ${i}`).join(
      "\n",
    );
    const after = before.replace(".f6 = 6", ".f6 = 60");
    const lines = programDiff(before, after);
    expect(lines.filter((line) => line.kind === "removed")).toEqual([
      { kind: "removed", text: ".f6 = 6" },
    ]);
    expect(lines.filter((line) => line.kind === "added")).toEqual([
      { kind: "added", text: ".f6 = 60" },
    ]);
    expect(lines[0]).toEqual({ kind: "fold", count: 4 });
    expect(lines.at(-1)).toEqual({ kind: "fold", count: 3 });
    // An unchanged last line without a line break is not reported as changed.
    expect(
      programDiff(
        '.env = "prod"\n.service = "web"',
        '.env = "dev"\n.service = "web"',
      ),
    ).toEqual([
      { kind: "removed", text: '.env = "prod"' },
      { kind: "added", text: '.env = "dev"' },
      { kind: "same", text: '.service = "web"' },
    ]);
  });

  it("counts devices assigned a version of this pipeline and those verified running", () => {
    const versions = [
      { id: "v1", number: 1 },
      { id: "v2", number: 2 },
    ];
    const reach = deviceReach(
      [
        { status: "verified", desired_version_id: "v2" },
        { status: "verified", desired_version_id: "v2" },
        { status: "online", desired_version_id: "v1" },
        { status: "revoked", desired_version_id: "v2" },
        { status: "verified", desired_version_id: "other" },
        { status: "online" },
      ],
      versions,
    );
    expect(reach).toEqual({
      assigned: 3,
      verified: 2,
      versions: [
        [2, 2],
        [1, 1],
      ],
    });
    expect(reachLabel(reach)).toBe(
      "Assigned to 3 devices (v2 ×2, v1 ×1) · 2 verified running.",
    );
    expect(reachLabel(deviceReach([], versions))).toBe(
      "Not assigned to any device yet.",
    );
    expect(
      reachLabel(
        deviceReach(
          [{ status: "verified", desired_version_id: "v1" }],
          versions,
        ),
      ),
    ).toBe("Assigned to 1 device (v1) · all verified running.");
  });
});

describe("publish review for large pipelines", () => {
  const many = Object.fromEntries(
    Array.from({ length: 36 }, (_, index) => [`s${index}`, { type: "file" }]),
  );
  it("folds a long run of added steps into one counted row", () => {
    const draft = {
      sources: many,
      transforms: { parse: { type: "remap", inputs: ["s0"], source: "." } },
      sinks: { out: { type: "console", inputs: ["parse"] } },
    };
    const rows = groupChanges(reviewChanges(null, draft).components);
    expect(rows.map((row) => row.kind)).toEqual(["group", "step", "step"]);
    const group = rows[0];
    expect(group.kind === "group" && group.components).toHaveLength(36);
    expect(sectionCount("sources", 36)).toBe("36 sources");
    expect(sectionCount("sinks", 1)).toBe("1 destination");
  });

  it("keeps changed steps and short runs as their own rows", () => {
    const before = { sources: { a: { type: "file" } } };
    const after = {
      sources: { a: { type: "file", include: ["/x"] }, b: { type: "file" } },
    };
    const rows = groupChanges(reviewChanges(before, after).components);
    expect(rows.map((row) => row.kind)).toEqual(["step", "step"]);
  });
});
