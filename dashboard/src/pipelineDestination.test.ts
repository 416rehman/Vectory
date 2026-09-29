import { describe, expect, it } from "vitest";
import {
  readPipelineDestination,
  pipelineDestinationLabel,
} from "./pipelineDestination";
import { pipelineRoute } from "./SelectedDevice";

describe("documentation destinations", () => {
  it("accepts read-only navigation intents and rejects executable actions", () => {
    expect(readPipelineDestination("panel=settings&section=secret")).toEqual({
      panel: "settings",
      section: "secret",
    });
    for (const action of [
      "publish",
      "deploy",
      "run-tests",
      "archive",
      "save",
      "__proto__",
    ])
      expect(readPipelineDestination(`panel=${action}`)).toBeUndefined();
    expect(
      readPipelineDestination("panel=settings&section=constructor"),
    ).toEqual({ panel: "settings" });
    expect(readPipelineDestination("panel=history&section=tests")).toEqual({
      panel: "history",
    });
  });
  it("retains device context while choosing a pipeline for a section", () => {
    const destination = readPipelineDestination(
      "panel=settings&section=tests",
    )!;
    expect(pipelineRoute("pipeline/id", "device?name=one", destination)).toBe(
      "configurations/pipeline%2Fid?device=device%3Fname%3Done&panel=settings&section=tests",
    );
    expect(pipelineDestinationLabel(destination)).toBe("Pipeline tests");
    expect(pipelineRoute(undefined, undefined, destination)).toBe(
      "configurations?panel=settings&section=tests",
    );
  });
});
