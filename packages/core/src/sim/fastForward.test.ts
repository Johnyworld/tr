import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { createTestStore } from "../testing.ts";
import { createDisturbanceCheck, fastForward, type InterruptCheck } from "./fastForward.ts";
import { TEST_SCENARIO } from "../testing.ts";

const disturbanceCheck = createDisturbanceCheck(TEST_SCENARIO);

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

  it("이상 징후는 밤에 더 자주 일어난다", () => {
    const count = (startHour: number) => {
      const rng = createSeededRng(11);
      let n = 0;
      for (let i = 0; i < 5000; i++) {
        const from = startHour * 60;
        if (disturbanceCheck({ state, from, to: from + 60, rng })) n++;
      }
      return n / 5000;
    };
    const night = count(22);
    const day = count(12);
    expect(night).toBeGreaterThan(day);
    expect(night).toBeCloseTo(0.08, 1);
    expect(day).toBeCloseTo(0.03, 1);
  });

  it("발생 시각은 틱 안에 있다", () => {
    const always = () => 0; // 확률 검사를 항상 통과
    const result = disturbanceCheck({ state, from: 120, to: 180, rng: always });
    expect(result?.at).toBeGreaterThan(120);
    expect(result?.at).toBeLessThanOrEqual(180);
  });
});
