import { describe, expect, it } from "vitest";
import {
  fieldIsSet,
  readPipelineDestination,
  pipelineDestinationLabel,
  pipelineFixHref,
  withStep,
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
  it("can select one test in the tests section, and nowhere else", () => {
    const destination = readPipelineDestination(
      "panel=settings&section=tests&test=2",
    )!;
    expect(destination).toEqual({
      panel: "settings",
      section: "tests",
      test: 2,
    });
    expect(pipelineRoute("pipeline", undefined, destination)).toBe(
      "configurations/pipeline?panel=settings&section=tests&test=2",
    );
    for (const test of ["0", "-1", "1.5", "two", "1000", "01", ""])
      expect(
        readPipelineDestination(`panel=settings&section=tests&test=${test}`),
      ).toEqual({ panel: "settings", section: "tests" });
    expect(
      readPipelineDestination("panel=settings&section=secret&test=2"),
    ).toEqual({ panel: "settings", section: "secret" });
    expect(readPipelineDestination("panel=history&test=2")).toEqual({
      panel: "history",
    });
  });
});

describe("a fix leads to a step and its field", () => {
  it("reads the step and the field a link names", () => {
    expect(readPipelineDestination("select=sample_rest&field=rate")).toEqual({
      panel: "step",
      select: "sample_rest",
      field: "rate",
    });
    expect(readPipelineDestination("select=out")).toEqual({
      panel: "step",
      select: "out",
    });
    expect(readPipelineDestination("select=out&field=encoding.codec")).toEqual({
      panel: "step",
      select: "out",
      field: "encoding.codec",
    });
    expect(readPipelineDestination("select=out&field=inputs[0]")).toEqual({
      panel: "step",
      select: "out",
      field: "inputs[0]",
    });
  });

  it("drops a field that is not a path and a step that is not named", () => {
    for (const field of ["", "a b", "a<b", "x".repeat(129), "a/b", '"'])
      expect(readPipelineDestination(`select=out&field=${field}`)).toEqual({
        panel: "step",
        select: "out",
      });
    expect(readPipelineDestination("field=rate")).toBeUndefined();
    expect(readPipelineDestination("select=")).toBeUndefined();
    expect(
      readPipelineDestination(`select=${"x".repeat(101)}`),
    ).toBeUndefined();
  });

  it("is a view like the others: a panel in the link wins, and nothing here runs", () => {
    expect(
      readPipelineDestination("panel=history&select=out&field=rate"),
    ).toEqual({ panel: "history" });
    expect(readPipelineDestination("select=publish&field=deploy")).toEqual({
      panel: "step",
      select: "publish",
      field: "deploy",
    });
  });

  it("writes the same parameters the link carries, with device context kept", () => {
    const destination = readPipelineDestination("select=a%26b&field=rate")!;
    expect(pipelineRoute("pipeline/id", "device 1", destination)).toBe(
      "configurations/pipeline%2Fid?device=device+1&select=a%26b&field=rate",
    );
    expect(pipelineDestinationLabel(destination)).toBe("the step");
    expect(readPipelineDestination("select=a%26b&field=rate")).toEqual(
      destination,
    );
  });

  it("builds the address of a fix", () => {
    expect(pipelineFixHref("p/1", "sample_rest", "rate")).toBe(
      "#/configurations/p%2F1?select=sample_rest&field=rate",
    );
    expect(pipelineFixHref("p1", "out")).toBe("#/configurations/p1?select=out");
    expect(withStep("#/configurations/p1?device=d", "out", "rate")).toBe(
      "#/configurations/p1?device=d&select=out&field=rate",
    );
    // A finding that names no step opens the pipeline alone.
    expect(pipelineFixHref("p1")).toBe("#/configurations/p1");
    expect(withStep("#/configurations/p1", undefined, "rate")).toBe(
      "#/configurations/p1",
    );
    expect(pipelineFixHref("p1", null, "rate")).toBe("#/configurations/p1");
    expect(pipelineFixHref("p1", "", "rate")).toBe("#/configurations/p1");
  });

  it("tells whether a step writes the setting a link names", () => {
    const step = {
      type: "route",
      rate: 0,
      route: { errors: ".level == 1" },
      routes: [{ condition: { source: "true" } }],
      exclude: null,
    };
    for (const path of [
      "type",
      "rate",
      "route.errors",
      "routes[0].condition",
      "routes.0.condition.source",
      "exclude",
    ])
      expect(fieldIsSet(step, path), path).toBe(true);
    for (const path of [
      "inputs",
      "route.other",
      "routes[1].condition",
      "rate.deep",
      "exclude.source",
      "constructor",
      "__proto__",
      "toString",
      "",
    ])
      expect(fieldIsSet(step, path), path).toBe(false);
    expect(fieldIsSet(undefined, "rate")).toBe(false);
    expect(fieldIsSet("text", "length")).toBe(false);
  });
});
