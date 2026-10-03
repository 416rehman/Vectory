import { describe, expect, it } from "vitest";
import {
  readWindows,
  windowProblem,
  windowsText,
  windowText,
} from "./updateWindow";

describe("an update window, in the agent's grammar", () => {
  it.each([
    "daily 02:00-04:00",
    "Mon-Fri 02:00-04:00",
    "Sat,Sun 01:00-03:00",
    "Mon 23:00-01:00",
    "Sat-Mon 00:00-06:00",
    "Sat,Sun 01:00-03:00 UTC",
    "daily 00:00-23:59 UTC",
    "Mon,Tue,Wed,Thu,Fri,Sat 00:00-01:00",
  ])("accepts %s", (spec) => {
    expect(windowProblem(spec)).toBe("");
  });

  it.each([
    ["", /can't be empty/],
    ["Mon-Fri 02:00-02:00", /end differs/],
    ["Mon-Fri 24:00-04:00", /Write a window like/],
    ["Mon-Fri 2:00-4:00", /Write a window like/],
    ["mon-fri 02:00-04:00", /Write a window like/],
    ["Monday 02:00-04:00", /Write a window like/],
    ["Mon-Fri 02:00-04:00 utc", /Write a window like/],
    ["Mon-Fri 02:00-04:00  UTC", /Write a window like/],
    ["Mon-Mon 02:00-04:00", /two different days/],
    ["Sat,Sat 02:00-04:00", /each day once/],
    ["Mon-Wed,Fri 02:00-04:00", /Write a window like/],
    ["Mox-Fri 02:00-04:00", /isn't a day/],
    ["Mon-Fri 02:00-04:00; daily 01:00-02:00", /Write a window like/],
    ["Mon-Fri 02:00–04:00", /printable ASCII/],
    ["Mon-Fri 02:00-04:00'; rm -rf /", /Write a window like/],
    ["Mon,Tue,Wed,Thu,Fri,Sat,Sun 00:00-01:00 UTC", /at most 40/],
  ])("refuses %j", (spec, message) => {
    expect(windowProblem(spec)).toMatch(message);
  });
});

describe("windows typed one per line", () => {
  it("reads them, skipping blank lines, and names the line that is wrong", () => {
    expect(readWindows("")).toEqual({ windows: [], problem: "" });
    expect(
      readWindows("Mon-Fri 02:00-04:00\n\n  daily 12:00-13:00  \n"),
    ).toEqual({
      windows: ["Mon-Fri 02:00-04:00", "daily 12:00-13:00"],
      problem: "",
    });
    expect(readWindows("Mon-Fri 02:00-04:00\nSoon").problem).toMatch(
      /^Window 2: Write a window like/,
    );
    expect(readWindows("Soon").problem).toMatch(/^Write a window like/);
  });

  it("allows seven windows, no eighth and no repeat", () => {
    const seven = Array.from(
      { length: 7 },
      (_, i) => `daily 0${i}:00-0${i}:30`,
    );
    expect(readWindows(seven.join("\n")).problem).toBe("");
    expect(
      readWindows([...seven, "daily 08:00-08:30"].join("\n")).problem,
    ).toMatch(/At most 7 windows/);
    expect(readWindows("daily 01:00-02:00\ndaily 01:00-02:00").problem).toMatch(
      /listed twice/,
    );
  });
});

describe("a window as the page shows it", () => {
  it("uses en dashes and keeps UTC", () => {
    expect(windowText("Mon-Fri 02:00-04:00")).toBe("Mon–Fri 02:00–04:00");
    expect(windowText("Sat,Sun 01:00-03:00 UTC")).toBe(
      "Sat,Sun 01:00–03:00 UTC",
    );
    expect(windowsText([])).toBe("Any time");
    expect(windowsText(["daily 01:00-02:00", "Sat,Sun 04:00-06:00"])).toBe(
      "daily 01:00–02:00, Sat,Sun 04:00–06:00",
    );
  });
});
