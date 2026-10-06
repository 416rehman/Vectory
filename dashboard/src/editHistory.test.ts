import { describe, expect, it } from "vitest";
import { coalesces, editedField } from "./editHistory";

const step = { type: "remap", inputs: ["in"], source: ".a = 1" };

describe("undo coalescing", () => {
  it("names the one option an edit changed", () => {
    expect(editedField("parse", step, { ...step, source: ".a = 12" })).toBe(
      "parse:source",
    );
    // A structurally equal copy of an unchanged option is not a change.
    expect(
      editedField("parse", step, {
        ...structuredClone(step),
        source: ".a = 2",
      }),
    ).toBe("parse:source");
    expect(editedField("parse", step, { ...step, drop_on_error: true })).toBe(
      "parse:drop_on_error",
    );
  });

  it("never coalesces edits that change several options or nothing", () => {
    expect(
      editedField("parse", step, { ...step, source: "", inputs: ["other"] }),
    ).toBeUndefined();
    expect(editedField("parse", step, { ...step })).toBeUndefined();
    expect(editedField("parse", null, step)).toBeUndefined();
  });

  it("joins typing in one field until a pause, another field or a structural edit", () => {
    // Replays keystrokes: [option, milliseconds since start].
    const keystrokes: [string | undefined, number][] = [
      ["parse:source", 0],
      ["parse:source", 180],
      ["parse:source", 420],
      ["parse:source", 1600], // paused over a second
      ["parse:source", 1700],
      ["parse:drop_on_error", 1800], // another option
      [undefined, 1850], // e.g. a new connection
      ["parse:drop_on_error", 1900],
    ];
    let previous: { key: string; at: number } | null = null,
      steps = 0;
    for (const [key, at] of keystrokes) {
      if (!coalesces(previous, key, at)) steps++;
      previous = key ? { key, at } : null;
    }
    expect(steps).toBe(5);
  });
});
