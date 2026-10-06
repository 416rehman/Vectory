import { describe, expect, it } from "vitest";
import { TOAST_GAP, toastLift, type Box } from "./toastPlacement";

// A 1440 x 900 window; the stack rests 420 wide, 24 from the right and bottom.
const rest: Box = { left: 996, right: 1416, top: 776, bottom: 876 };
const bar: Box = { left: 0, right: 1440, top: 860, bottom: 900 };

describe("where notifications sit", () => {
  it("stays put when nothing is in the way", () => {
    expect(toastLift(rest, [])).toBe(0);
  });

  it("rises above a bar that runs under the stack", () => {
    expect(toastLift(rest, [bar])).toBe(876 - 860 + TOAST_GAP);
    // Placed that high, the stack's bottom edge is exactly the gap above it.
    expect(rest.bottom - toastLift(rest, [bar])).toBe(bar.top - TOAST_GAP);
  });

  it("ignores what is beside it or above it", () => {
    expect(
      toastLift(rest, [
        { left: 0, right: 900, top: 800, bottom: 900 },
        { left: 0, right: 1440, top: 100, bottom: 140 },
      ]),
    ).toBe(0);
  });

  it("clears a dialog footer and the bar beneath it", () => {
    const footer: Box = { left: 700, right: 1200, top: 700, bottom: 760 };
    const lift = toastLift(rest, [bar, footer]);
    expect(rest.bottom - lift).toBeLessThanOrEqual(footer.top - TOAST_GAP);
    expect(rest.top - lift).toBeLessThan(footer.top);
  });

  it("keeps clear of an obstacle it rises onto", () => {
    // The bar lifts it 24px; the strip above the bar then lifts it again.
    const strip: Box = { left: 1000, right: 1440, top: 820, bottom: 855 };
    const lift = toastLift(rest, [bar, strip]);
    expect(rest.bottom - lift).toBeLessThanOrEqual(strip.top - TOAST_GAP);
  });

  it("clears a phone's full-width footer", () => {
    const phone: Box = { left: 12, right: 378, top: 724, bottom: 832 };
    const footer: Box = { left: 0, right: 390, top: 760, bottom: 844 };
    const lift = toastLift(phone, [footer]);
    expect(phone.bottom - lift).toBe(footer.top - TOAST_GAP);
  });
});
