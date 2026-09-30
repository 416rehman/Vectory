import { describe, expect, it } from "vitest";
import { DIRECTORY_TTL_MS, createAnswerCache } from "./directoryCache";

describe("directory answers", () => {
  it("reuses an answer for thirty seconds", () => {
    const cache = createAnswerCache();
    cache.remember("u1 /groups?slim=1", ["a"], 1_000, 0);
    expect(DIRECTORY_TTL_MS).toBe(30_000);
    expect(cache.recall("u1 /groups?slim=1", 1_000, 0)).toEqual(["a"]);
    expect(cache.recall("u1 /groups?slim=1", 30_999, 0)).toEqual(["a"]);
    expect(cache.recall("u1 /groups?slim=1", 31_000, 0)).toBeUndefined();
    // An expired answer is gone, not revived by a later recall.
    expect(cache.size).toBe(0);
  });

  it("drops every answer once something changed", () => {
    const cache = createAnswerCache();
    cache.remember("u1 /groups?slim=1", ["a"], 1_000, 4);
    expect(cache.recall("u1 /groups?slim=1", 2_000, 4)).toEqual(["a"]);
    expect(cache.recall("u1 /groups?slim=1", 2_000, 5)).toBeUndefined();
  });

  it("drops an answer whose read a change overlapped", () => {
    const cache = createAnswerCache();
    // The read began at change count 4; by the time it was kept the count was 5.
    cache.remember("u1 /users", [], 2_000, 4);
    expect(cache.recall("u1 /users", 2_100, 5)).toBeUndefined();
  });

  it("keeps each person's answers apart", () => {
    const cache = createAnswerCache();
    cache.remember("u1 /users", ["admin's list"], 1_000, 0);
    expect(cache.recall("u2 /users", 1_000, 0)).toBeUndefined();
  });

  it("does not trust a clock that went backwards", () => {
    const cache = createAnswerCache();
    cache.remember("u1 /users", [], 5_000, 0);
    expect(cache.recall("u1 /users", 4_000, 0)).toBeUndefined();
  });

  it("keeps a bounded number of answers, oldest first out", () => {
    const cache = createAnswerCache(DIRECTORY_TTL_MS, 3);
    for (const key of ["a", "b", "c", "d"]) cache.remember(key, key, 1_000, 0);
    expect(cache.size).toBe(3);
    expect(cache.recall("a", 1_000, 0)).toBeUndefined();
    expect(cache.recall("d", 1_000, 0)).toBe("d");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
