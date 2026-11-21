import { describe, expect, it } from "vitest";
import { preferRested, restDays, resting } from "./rest.ts";

const content = { scenario: { rest: { cast: 2, mission: 3 } } } as never;

describe("공통 규칙 5: 같은 것은 쉰다", () => {
  it("시나리오의 날수만큼 쉬고, 적지 않은 종류는 쉬지 않는다", () => {
    expect(restDays(content, "cast")).toBe(2);
    expect(restDays(content, "alarm")).toBe(0);
    expect(resting(content, "cast", 0, 1439)).toBe(true);
    expect(resting(content, "cast", 0, 2 * 1440)).toBe(false);
    expect(resting(content, "cast", null, 10)).toBe(false);
  });

  it("다른 후보가 있으면 쉬는 것을 빼고, 모두 쉬는 중이면 다시 쓴다", () => {
    expect(preferRested(["a", "b"], (x) => x === "a")).toEqual(["b"]);
    expect(preferRested(["a"], () => true)).toEqual(["a"]);
  });
});
