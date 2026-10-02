import { beforeEach, describe, expect, it } from "vitest";
import { notifyToast, refusal, toast, toastSnapshot } from "./toast";

beforeEach(() => toast.clear());

describe("toast store", () => {
  it("uses the tone the caller states, whatever the wording", () => {
    notifyToast("Group saved.", { tone: "success" });
    notifyToast("Couldn't save the group.", { tone: "info" });
    notifyToast("Draft revision saved.", { tone: "error" });
    expect(toastSnapshot().map((item) => item.tone)).toEqual([
      "success",
      "info",
      "error",
    ]);
  });

  it("says a refused gesture as an error that leaves after six seconds", () => {
    notifyToast("This connection already exists.", refusal);
    expect(toastSnapshot()[0]).toMatchObject({
      tone: "error",
      duration: 6000,
    });
    notifyToast("Couldn't publish.", { tone: "error" });
    expect(toastSnapshot()[1]).toMatchObject({ tone: "error", duration: null });
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

  it("replaces an earlier message on the same topic, and dismisses a topic once it stops being true", () => {
    notifyToast("Added pipeline test “a”. Save to keep it.", {
      tone: "success",
      topic: "unsaved-tests",
    });
    notifyToast("Added 2 pipeline tests. Save to keep them.", {
      tone: "success",
      topic: "unsaved-tests",
    });
    notifyToast("Imported.", { tone: "success" });
    expect(toastSnapshot().map((item) => item.message)).toEqual([
      "Added 2 pipeline tests. Save to keep them.",
      "Imported.",
    ]);
    toast.dismissTopic("unsaved-tests");
    expect(toastSnapshot().map((item) => item.message)).toEqual(["Imported."]);
    // A topic nobody used leaves every message in place.
    toast.dismissTopic("nothing");
    expect(toastSnapshot()).toHaveLength(1);
    // Messages without a topic are never swept up by one.
    toast.dismissTopic("undefined");
    expect(toastSnapshot()).toHaveLength(1);
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
