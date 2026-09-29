import { describe, expect, it } from "vitest";
import { describeAgent } from "./userAgent";

describe("session user agents", () => {
  it("names common browsers and systems", () => {
    expect(
      describeAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toEqual({ label: "Chrome on macOS", kind: "desktop" });
    expect(
      describeAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ).label,
    ).toBe("Edge on Windows");
    expect(
      describeAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ label: "Safari on iOS", kind: "mobile" });
    expect(
      describeAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ).label,
    ).toBe("Firefox on Linux");
    expect(
      describeAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ label: "Chrome on Android", kind: "mobile" });
    expect(
      describeAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      ).label,
    ).toBe("Chrome on Linux");
  });
  it("recognizes command-line clients and unknown values", () => {
    expect(describeAgent("curl/8.9.1")).toEqual({
      label: "curl",
      kind: "tool",
    });
    expect(describeAgent("python-requests/2.32")).toEqual({
      label: "Python",
      kind: "tool",
    });
    expect(describeAgent(null).label).toBe("Unknown browser");
    expect(describeAgent("SomethingElse/1.0").label).toBe("Unknown browser");
  });
});
