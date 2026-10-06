import { describe, expect, it } from "vitest";
import { rankEntries, type PaletteEntry } from "./commandPaletteModel";
import { commandFor } from "./commands";
import {
  askedVerbs,
  deviceVerbs,
  pipelineVerbs,
  queryAsksFor,
  rolloutVerbs,
  wordsNamingThings,
  type RolloutSubject,
} from "./paletteVerbs";

const id = "00000000-0000-4000-8000-0000000000A1";
const operator = { operate: true, edit: false };
const editor = { operate: false, edit: true };
const admin = { operate: true, edit: true };
const viewer = { operate: false, edit: false };
const rollout = (extra: Partial<RolloutSubject> = {}): RolloutSubject => ({
  id,
  status: "active",
  version_id: "v",
  rolled_back_by: null,
  ...extra,
});
const verbs = (entries: { verb: string }[]) => entries.map((e) => e.verb);

describe("verbs on a rollout", () => {
  it("offers pause, cancel and roll back to someone who can operate, as the rollout page does", () => {
    const entries = rolloutVerbs(
      rollout(),
      "Edge syslog processing v2",
      operator,
    );
    expect(verbs(entries)).toEqual(["pause", "cancel", "rollback"]);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Pause Edge syslog processing v2",
      "Cancel Edge syslog processing v2",
      "Roll back Edge syslog processing v2",
    ]);
    // Each runs a command the rollout's own page registers, named for it.
    expect(entries[0].command).toEqual({
      name: commandFor("rollout.pause", id),
      route: `deployments/${id}`,
    });
    expect(entries[0].command!.name).toBe(
      "rollout.pause:00000000-0000-4000-8000-0000000000a1",
    );
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(3);
    for (const entry of entries) expect(entry.kind).toBe("action");
  });

  it("offers nothing to a person who cannot operate", () => {
    for (const roles of [editor, viewer])
      expect(rolloutVerbs(rollout(), "Edge", roles)).toEqual([]);
  });

  it("follows the state the page does", () => {
    const offered = (extra: Partial<RolloutSubject>) =>
      verbs(rolloutVerbs(rollout(extra), "Edge", admin));
    expect(offered({ status: "paused" })).toEqual(["cancel", "rollback"]);
    expect(offered({ status: "scheduled" })).toEqual(["cancel"]);
    expect(offered({ status: "completed" })).toEqual(["rollback"]);
    expect(offered({ status: "failed" })).toEqual(["rollback"]);
    expect(offered({ status: "cancelled" })).toEqual(["rollback"]);
    expect(offered({ status: "missed" })).toEqual([]);
    expect(offered({ status: "unassigned" })).toEqual([]);
    // Settings have no version to return to; a rollback is not rolled back
    // twice; the server says when there is nothing to return to.
    expect(offered({ version_id: null })).toEqual(["pause", "cancel"]);
    expect(offered({ rolled_back_by: "other" })).toEqual(["pause", "cancel"]);
    expect(offered({ rollback_available: false })).toEqual(["pause", "cancel"]);
    expect(offered({ rollback_available: true })).toEqual([
      "pause",
      "cancel",
      "rollback",
    ]);
  });

  it("calls the cancel of a schedule by that name", () => {
    const [cancel] = rolloutVerbs(
      rollout({ status: "scheduled" }),
      "Edge syslog processing v2",
      admin,
    );
    expect(cancel.title).toBe("Cancel schedule for Edge syslog processing v2");
  });
});

describe("verbs on a pipeline", () => {
  const pipeline = {
    id: "p1",
    name: "Edge syslog processing",
    latest_version: { number: 3 },
  };
  it("deploys the latest published version for someone who can operate and duplicates for someone who can edit", () => {
    expect(verbs(pipelineVerbs(pipeline, admin))).toEqual([
      "deploy",
      "duplicate",
    ]);
    const [deploy] = pipelineVerbs(pipeline, operator);
    expect(deploy.title).toBe("Deploy Edge syslog processing v3…");
    expect(deploy.command).toEqual({
      name: "pipeline.deploy:p1",
      route: "configurations/p1",
    });
    expect(pipelineVerbs(pipeline, editor).map((entry) => entry.title)).toEqual(
      ["Duplicate Edge syslog processing…"],
    );
    expect(pipelineVerbs(pipeline, viewer)).toEqual([]);
  });

  it("has nothing to deploy until a version is published", () => {
    expect(
      verbs(pipelineVerbs({ ...pipeline, latest_version: null }, admin)),
    ).toEqual(["duplicate"]);
    expect(verbs(pipelineVerbs({ id: "p", name: "Draft" }, operator))).toEqual(
      [],
    );
  });
});

describe("verbs on a device", () => {
  it("shows its issues to anyone", () => {
    const [entry] = deviceVerbs({ id: "d/1", name: "edge-nyc-01" });
    expect(entry).toMatchObject({
      verb: "issues",
      title: "Show issues for edge-nyc-01",
      href: "#/issues?device=d%2F1",
    });
    expect(entry.command).toBeUndefined();
  });
});

describe("when the words typed ask for a verb", () => {
  it("answers to the verb, a short start of it, or a word that means the same", () => {
    for (const [query, verb] of [
      ["pause edge", "pause"],
      ["pa", "pause"],
      ["hold", "pause"],
      ["cancel", "cancel"],
      ["stop rollout", "cancel"],
      ["roll back", "rollback"],
      ["rollback syslog", "rollback"],
      ["revert", "rollback"],
      ["deploy", "deploy"],
      ["dep edge", "deploy"],
      ["ship it", "deploy"],
      ["duplicate", "duplicate"],
      ["copy edge", "duplicate"],
      ["issues edge-1", "issues"],
      ["show edge-1", "issues"],
    ] as const)
      expect(queryAsksFor(query, verb), `${query} -> ${verb}`).toBe(true);
  });

  it("does not answer to a name that merely resembles one", () => {
    for (const query of [
      "edge syslog",
      "devices",
      "collectors",
      "p",
      "d",
      "",
      "   ",
    ])
      for (const verb of [
        "pause",
        "cancel",
        "rollback",
        "deploy",
        "duplicate",
        "issues",
      ] as const)
        expect(queryAsksFor(query, verb), `${query} -> ${verb}`).toBe(false);
    // A longer word does not ask for a verb it only begins with.
    expect(queryAsksFor("pausing", "pause")).toBe(false);
    expect(queryAsksFor("copyright", "duplicate")).toBe(false);
  });

  it("lists only the verbs asked for", () => {
    const all = [
      ...rolloutVerbs(rollout(), "Edge syslog processing v2", admin),
      ...pipelineVerbs(
        {
          id: "p1",
          name: "Edge syslog processing",
          latest_version: { number: 2 },
        },
        admin,
      ),
    ];
    expect(verbs(askedVerbs("edge syslog", all))).toEqual([]);
    expect(verbs(askedVerbs("pause edge", all))).toEqual(["pause"]);
    expect(verbs(askedVerbs("roll back", all))).toEqual(["rollback"]);
    expect(verbs(askedVerbs("deploy", all))).toEqual(["deploy"]);
  });

  it("looks up what is named, not the verb that asked", () => {
    for (const [typed, named] of [
      ["pause edge", "edge"],
      ["roll back edge syslog", "edge syslog"],
      ["show issues lab-1", "lab-1"],
      ["Deploy  Edge", "Edge"],
      // Nothing is named: the words are looked up as typed.
      ["pause", "pause"],
      ["dep", "dep"],
      ["roll back", "roll back"],
      ["  edge  ", "edge"],
      ["edge syslog", "edge syslog"],
      ["back edge", "back edge"],
    ] as const)
      expect(wordsNamingThings(typed), typed).toBe(named);
  });
});

describe("verbs among the palette's results", () => {
  const entries: PaletteEntry[] = [
    {
      key: "deployment:1",
      kind: "deployment",
      title: "Edge syslog processing v2",
      subtitle: "3 devices",
    },
    {
      key: "pipeline:1",
      kind: "pipeline",
      title: "Edge syslog processing",
    },
    ...rolloutVerbs(rollout(), "Edge syslog processing v2", admin),
    ...pipelineVerbs(
      {
        id: "p1",
        name: "Edge syslog processing",
        latest_version: { number: 2 },
      },
      admin,
    ),
  ];

  it("finds a verb by its name and the thing's name", () => {
    const found = (query: string) =>
      rankEntries(
        [
          ...entries.slice(0, 2),
          ...askedVerbs(query, entries.slice(2) as never),
        ],
        query,
      );
    const actions = (query: string) =>
      found(query)
        .find((group) => group.kind === "action")
        ?.items.map((item) => item.title);
    expect(actions("pause edge")).toEqual(["Pause Edge syslog processing v2"]);
    expect(actions("roll back edge")).toEqual([
      "Roll back Edge syslog processing v2",
    ]);
    expect(actions("deploy syslog")).toEqual([
      "Deploy Edge syslog processing v2…",
    ]);
    // The name alone finds the things, and no verb.
    expect(found("edge syslog").map((group) => group.kind)).toEqual([
      "pipeline",
      "deployment",
    ]);
  });

  it("finds a verb by a word that means it, without its own name", () => {
    const query = "revert syslog";
    const found = rankEntries(
      askedVerbs(query, entries.slice(2) as never),
      query,
    );
    expect(found[0].items.map((item) => item.title)).toEqual([
      "Roll back Edge syslog processing v2",
    ]);
  });
});
