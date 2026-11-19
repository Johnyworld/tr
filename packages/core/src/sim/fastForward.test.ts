import { describe, expect, it } from "vitest";
import { createTestStore } from "../testing.ts";
import { createInterruptChecks, fastForward, type InterruptCheck } from "./fastForward.ts";
import { TEST_SCENARIO } from "../testing.ts";

const state = createTestStore().getState();

describe("fastForward", () => {
  it("끼어들기가 없으면 끝까지 간다", () => {
    const result = fastForward({ state, start: 0, until: 300, rng: Math.random, checks: [] });
    expect(result).toEqual({ end: 300, interrupt: null });
  });

  it("끼어들기가 생기면 그 시각에 멈춘다", () => {
    const calls: [number, number][] = [];
    const third: InterruptCheck = ({ from, to }) => {
      calls.push([from, to]);
      return calls.length === 3 ? { kind: "disturbance", detail: "테스트", at: from + 20 } : null;
    };
    const result = fastForward({ state, start: 0, until: 600, rng: Math.random, checks: [third] });
    expect(calls).toEqual([
      [0, 60],
      [60, 120],
      [120, 180],
    ]);
    expect(result.end).toBe(140);
    expect(result.interrupt?.detail).toBe("테스트");
  });

  it("마지막 틱은 남은 시간만큼만 돈다", () => {
    const calls: [number, number][] = [];
    const record: InterruptCheck = ({ from, to }) => (calls.push([from, to]), null);
    fastForward({ state, start: 0, until: 90, rng: Math.random, checks: [record] });
    expect(calls).toEqual([
      [0, 60],
      [60, 90],
    ]);
  });

  it("아무 일도 없으면 밤새 깨지 않는다 (이상 징후는 12-187에 뺐다)", () => {
    const result = fastForward({ state, start: 18 * 60, until: 30 * 60, rng: () => 0, checks: createInterruptChecks(TEST_SCENARIO) });
    expect(result).toEqual({ end: 30 * 60, interrupt: null });
  });
});
