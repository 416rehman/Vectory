import { describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  describeFailure,
  isDefiniteRefusal,
  unconfirmedText,
} from "./agentUpdateRequests";

const refusal = (code: string, status: number, message = "From the server.") =>
  new APIError(code, message, status, true);

describe("a refusal the server made", () => {
  it("is final for every answer it gives to a request it understood", () => {
    for (const [code, status] of [
      ["WRONG_PASSWORD", 403],
      ["RELEASE_KEY_INVALID", 422],
      ["STALE_REVISION", 409],
      ["UPDATE_REVIEW_CHANGED", 409],
      ["AGENT_UPDATES_OFF", 404],
      ["RELEASE_STORAGE_FULL", 507],
    ] as const)
      expect(isDefiniteRefusal(refusal(code, status)), code).toBe(true);
  });

  it("is not claimed for a reply that isn't the server's, a deadline or a lost connection", () => {
    expect(isDefiniteRefusal(new APIError("REQUEST_TIMEOUT", "slow", 0))).toBe(
      false,
    );
    expect(
      isDefiniteRefusal(new APIError("NETWORK_UNAVAILABLE", "down", 0)),
    ).toBe(false);
    expect(isDefiniteRefusal(new APIError("REQUEST_FAILED", "boom", 500))).toBe(
      false,
    );
    expect(isDefiniteRefusal(refusal("CONTRACT_MISMATCH", 502))).toBe(false);
    expect(isDefiniteRefusal(refusal("IDEMPOTENCY_CONFLICT", 409))).toBe(false);
    expect(
      isDefiniteRefusal(new APIError("REQUEST_TIMEOUT", "slow", 408, true)),
    ).toBe(false);
    expect(isDefiniteRefusal(new Error("x"))).toBe(false);
  });
});

describe("what a failure says", () => {
  it("puts a wrong password and a bad key under their fields", () => {
    expect(describeFailure(refusal("WRONG_PASSWORD", 403))).toMatchObject({
      message: "Your password didn't match.",
      field: "password",
      definite: true,
    });
    expect(
      describeFailure(
        refusal("RELEASE_KEY_INVALID", 422, "That key is a small-order point."),
      ),
    ).toMatchObject({
      message: "That key is a small-order point.",
      field: "key",
    });
    expect(describeFailure(refusal("RELEASE_KEY_IN_USE", 409)).field).toBe(
      "key",
    );
    expect(
      describeFailure(refusal("RELEASE_SIGNATURE_INVALID", 422)).field,
    ).toBe("file");
  });

  it("explains the codes of a rollout that can't start", () => {
    expect(
      describeFailure(refusal("UPDATE_REVIEW_CHANGED", 409)).message,
    ).toMatch(/Review again before you start/);
    expect(
      describeFailure(refusal("AGENT_UPDATES_STOPPED", 409)).message,
    ).toMatch(/clears the stop in Settings/);
    expect(describeFailure(refusal("NOTHING_TO_UPDATE", 409)).message).toMatch(
      /Nobody in this review will update/,
    );
  });

  it("falls back to the server's own sentence for a code it doesn't know", () => {
    expect(
      describeFailure(refusal("SOMETHING_NEW", 409, "The server says so.")),
    ).toMatchObject({
      message: "The server says so.",
      definite: true,
    });
  });

  it("says how long to wait after too many attempts", () => {
    const limited = new APIError("RATE_LIMITED", "slow down", 429, true, 120);
    expect(describeFailure(limited).message).toBe(
      "Too many attempts. Try again in 2 min.",
    );
  });

  it("does not call an unanswered request settled, and says it may have been applied", () => {
    const failure = describeFailure(
      new APIError("REQUEST_TIMEOUT", "Taking too long.", 0),
    );
    expect(failure.definite).toBe(false);
    expect(unconfirmedText("that agent updates were turned on")).toBe(
      "We couldn't confirm that agent updates were turned on. It may have been applied. Check the current state before you try again.",
    );
  });
});
