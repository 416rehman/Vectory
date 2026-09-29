import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand, runCommand } from "./commands";

const location = { hash: "#/overview" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 29, 9));
  location.hash = "#/overview";
  vi.stubGlobal("window", { location });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("command bus", () => {
  it("runs a registered command at once", () => {
    const handler = vi.fn();
    const release = registerCommand("group.create", handler);
    expect(runCommand("group.create", "groups")).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/overview");
    release();
  });

  it("opens the page and runs once it registers", () => {
    expect(runCommand("pipeline.create", "configurations")).toBe(true);
    expect(location.hash).toBe("/configurations");
    location.hash = "#/configurations";
    vi.runAllTimers();
    const handler = vi.fn();
    const release = registerCommand("pipeline.create", handler);
    vi.runAllTimers();
    expect(handler).toHaveBeenCalledOnce();
    release();
    // Only once: a later visit does not run it again.
    const again = vi.fn();
    registerCommand("pipeline.create", again)();
    vi.runAllTimers();
    expect(again).not.toHaveBeenCalled();
  });

  it("forgets a request older than ten seconds", () => {
    runCommand("pipeline.create", "configurations");
    location.hash = "#/configurations";
    vi.advanceTimersByTime(11_000);
    const handler = vi.fn();
    registerCommand("pipeline.create", handler)();
    vi.runAllTimers();
    expect(handler).not.toHaveBeenCalled();
  });

  it("forgets a request when the page refuses to leave", () => {
    runCommand("pipeline.create", "configurations");
    // The current page put its hash back (unsaved work).
    location.hash = "#/overview";
    vi.runAllTimers();
    location.hash = "#/configurations";
    const handler = vi.fn();
    registerCommand("pipeline.create", handler)();
    vi.runAllTimers();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does nothing without a handler or a route", () => {
    expect(runCommand("unknown.command")).toBe(false);
  });

  it("unregisters only its own handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = registerCommand("device.add", first);
    const releaseSecond = registerCommand("device.add", second);
    releaseFirst();
    runCommand("device.add");
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
    expect(runCommand("device.add")).toBe(false);
  });
});
