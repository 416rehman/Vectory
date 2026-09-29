import { beforeEach, describe, expect, it } from "vitest";
import { guessTone, notifyToast, toast, toastSnapshot } from "./toast";

beforeEach(() => toast.clear());

describe("toast store", () => {
  it("uses the tone the caller states", () => {
    notifyToast("Group saved.", { tone: "success" });
    notifyToast("Couldn't save the group.", { tone: "info" });
    expect(toastSnapshot().map((item) => item.tone)).toEqual([
      "success",
      "info",
    ]);
  });

  it("reads the wording only when no tone is given", () => {
    expect(guessTone("Failed to publish")).toBe("error");
    expect(guessTone("Couldn't copy")).toBe("error");
    expect(guessTone("Draft revision saved.")).toBe("info");
    notifyToast("Unable to reach the server");
    expect(toastSnapshot()[0]).toMatchObject({ tone: "error", duration: null });
  });

  it("keeps errors until dismissed and confirmations for five seconds", () => {
    toast.error("Couldn't load devices.");
    toast.success("Saved.");
    const [error, success] = toastSnapshot();
    expect(error.duration).toBeNull();
    expect(success.duration).toBe(5000);
    toast.info("Custom", { duration: 1000 });
    expect(toastSnapshot()[2].duration).toBe(1000);
  });

  it("replaces an identical visible message instead of stacking it", () => {
    toast.success("Group saved.");
    toast.success("Group saved.");
    expect(toastSnapshot()).toHaveLength(1);
    toast.error("Group saved.");
    expect(toastSnapshot()).toHaveLength(2);
  });

  it("shows three at most and never pushes out a persistent error first", () => {
    toast.error("Rollout failed.");
    toast.success("One.");
    toast.success("Two.");
    toast.success("Three.");
    expect(toastSnapshot().map((item) => item.message)).toEqual([
      "Rollout failed.",
      "Two.",
      "Three.",
    ]);
    toast.error("Second failure.");
    toast.error("Third failure.");
    toast.error("Fourth failure.");
    // Only errors left: the oldest goes, the newest always shows.
    expect(toastSnapshot().map((item) => item.message)).toEqual([
      "Second failure.",
      "Third failure.",
      "Fourth failure.",
    ]);
  });

  it("dismisses by id and keeps an action", () => {
    const id = toast.success("Group saved.", {
      action: { label: "View devices", href: "#/devices?group=g" },
    });
    expect(toastSnapshot()[0].action).toEqual({
      label: "View devices",
      href: "#/devices?group=g",
    });
    toast.dismiss(id);
    expect(toastSnapshot()).toEqual([]);
  });
});
