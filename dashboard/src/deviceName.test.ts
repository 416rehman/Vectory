import { describe, expect, it } from "vitest";
import { deviceDisplay, deviceLabel } from "./deviceName";

const identity = "0b8f3c2a-5d41-4e7a-9a16-2c4d7e9f1b35";

describe("a retired identity's name", () => {
  it("shows the name the device had and says it is retired", () => {
    // What the server stores after a recovery: the name, "#retired-", then the id of the identity it replaced.
    expect(deviceDisplay(`edge-nyc-01#retired-${identity}`)).toEqual({
      name: "edge-nyc-01",
      retired: true,
    });
    expect(deviceLabel(`edge-nyc-01#retired-${identity}`)).toBe(
      "edge-nyc-01 (retired identity)",
    );
  });
  it("accepts an upper-case identity", () => {
    expect(
      deviceDisplay(`edge-nyc-02#retired-${identity.toUpperCase()}`),
    ).toEqual({ name: "edge-nyc-02", retired: true });
  });
  it("leaves every other name alone", () => {
    for (const name of [
      "edge-nyc-01",
      "edge.nyc_01",
      "",
      "#retired-" + identity,
      "edge-nyc-01#retired-",
      "edge-nyc-01#retired-not-an-id",
      `edge-nyc-01#retired-${identity}-later`,
      `edge-nyc-01 #retired-${identity.slice(0, 30)}`,
    ]) {
      expect(deviceDisplay(name)).toEqual({ name, retired: false });
      expect(deviceLabel(name)).toBe(name);
    }
  });
  it("takes only the marker at the end, so a name that mentions one keeps it", () => {
    const first = `a#retired-${identity}`;
    expect(deviceDisplay(`${first}#retired-${identity}`)).toEqual({
      name: first,
      retired: true,
    });
  });
});
