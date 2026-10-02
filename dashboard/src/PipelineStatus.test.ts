import { describe, expect, it } from "vitest";
import type { PipelineSummary } from "./api";
import { libraryStatus } from "./PipelineStatus";
import type { RolloutOutcome } from "./rolloutOutcome";

const base: PipelineSummary = {
  id: "p",
  name: "P",
  description: "",
  revision: 4,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  archived: false,
  archived_at: null,
  component_counts: { sources: 1, transforms: 0, sinks: 1 },
  latest_version: null,
};
const version = (draft_changed?: boolean) => ({
  id: "v",
  number: 3,
  created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
  author: "Ada",
  draft_changed,
});

describe("library status", () => {
  it("says which version devices run, not only where it is assigned", () => {
    const latest = { ...base, latest_version: version(false) };
    expect(
      libraryStatus({
        ...latest,
        assigned_devices: 3,
        running_versions: [{ id: "v2", number: 2, devices: 3 }],
      }).detail,
    ).toBe("Running v2 on 3 of 3 · v3 not running");
    expect(
      libraryStatus({
        ...latest,
        assigned_devices: 3,
        running_versions: [
          { id: "v3", number: 3, devices: 2 },
          { id: "v2", number: 2, devices: 1 },
        ],
      }).detail,
    ).toBe("Running v3 on 2, v2 on 1 of 3");
    expect(
      libraryStatus({
        ...latest,
        assigned_devices: 1,
        running_versions: [{ id: "v3", number: 3, devices: 1 }],
      }).detail,
    ).toBe("Running v3 on 1 of 1");
    expect(
      libraryStatus({ ...latest, assigned_devices: 2, running_versions: [] })
        .detail,
    ).toBe("Assigned to 2 devices · not verified running yet");
    expect(
      libraryStatus({ ...latest, assigned_devices: 0, running_versions: [] })
        .detail,
    ).toBe("Not assigned to devices");
  });

  it("leads with the published version and where it is assigned", () => {
    expect(
      libraryStatus({
        ...base,
        latest_version: version(false),
        assigned_devices: 3,
      }),
    ).toMatchObject({
      primary: "v3 · Published 2h ago",
      detail: "Assigned to 3 devices",
      changed: false,
    });
  });

  it("flags unpublished changes only when the draft differs", () => {
    expect(
      libraryStatus({ ...base, latest_version: version(true) }).changed,
    ).toBe(true);
    expect(libraryStatus({ ...base, latest_version: version() }).changed).toBe(
      false,
    );
  });

  describe("how the latest version's rollout ended", () => {
    const failed: RolloutOutcome = {
      kind: "failed",
      deploymentId: "d1",
      at: "2026-10-02T18:57:21Z",
      devices: 1,
    };
    const latest = { ...base, latest_version: version(false) };
    it("says a rolled-back version failed, where the row said only that it was not assigned", () => {
      const status = libraryStatus(
        { ...latest, assigned_devices: 0, running_versions: [] },
        { ...failed, kind: "rolled_back" },
      );
      expect(status.detail).toBe("Not assigned to devices");
      expect(status.outcome).toEqual({
        text: "v3 rolled back on 1 device",
        at: failed.at,
        deploymentId: "d1",
      });
    });
    it("names it while only an older version runs", () => {
      expect(
        libraryStatus(
          {
            ...latest,
            assigned_devices: 3,
            running_versions: [{ id: "v2", number: 2, devices: 3 }],
          },
          failed,
        ).outcome?.text,
      ).toBe("v3 failed on 1 device");
    });
    it("stays silent once a device runs the version, or when nothing is known", () => {
      expect(
        libraryStatus(
          {
            ...latest,
            assigned_devices: 3,
            running_versions: [{ id: "v3", number: 3, devices: 1 }],
          },
          failed,
        ).outcome,
      ).toBeUndefined();
      expect(libraryStatus({ ...latest, assigned_devices: 0 }).outcome).toBe(
        undefined,
      );
      expect(
        libraryStatus(
          { ...base, archived: true, latest_version: version() },
          failed,
        ).outcome,
      ).toBeUndefined();
    });
  });

  it("describes drafts and archived pipelines without counting revisions", () => {
    expect(libraryStatus(base)).toMatchObject({
      primary: "Not published",
      detail: "Draft only",
    });
    expect(
      libraryStatus({
        ...base,
        archived: true,
        latest_version: version(true),
      }),
    ).toEqual({ primary: "Archived · v3", changed: false });
    expect(
      libraryStatus({
        ...base,
        latest_version: version(false),
        assigned_devices: 1,
      }).detail,
    ).toBe("Assigned to 1 device");
  });
});
