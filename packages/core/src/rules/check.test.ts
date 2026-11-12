import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { roll2d6, standardOutcomeTable, type CheckOutcome } from "./check.ts";

/** 2d6의 36가지 조합을 전부 세어 결과 확률을 구한다 */
function exactDistribution(modifier: number): Record<CheckOutcome, number> {
  const counts: Record<CheckOutcome, number> = { success: 0, partial: 0, miss: 0 };
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) counts[standardOutcomeTable(a + b + modifier)]++;
  }
  return {
    success: Math.round((counts.success / 36) * 100),
    partial: Math.round((counts.partial / 36) * 100),
    miss: Math.round((counts.miss / 36) * 100),
  };
}

describe("2d6 판정", () => {
  it("기획서 4.1의 확률표와 일치한다", () => {
    expect(exactDistribution(-1)).toEqual({ success: 8, partial: 33, miss: 58 });
    expect(exactDistribution(0)).toEqual({ success: 17, partial: 42, miss: 42 });
    expect(exactDistribution(1)).toEqual({ success: 28, partial: 44, miss: 28 });
    expect(exactDistribution(2)).toEqual({ success: 42, partial: 42, miss: 17 });
  });

  it("결과 경계: 10+ 성공, 7~9 대가 있는 성공, 6- 실패", () => {
    expect(standardOutcomeTable(10)).toBe("success");
    expect(standardOutcomeTable(9)).toBe("partial");
    expect(standardOutcomeTable(7)).toBe("partial");
    expect(standardOutcomeTable(6)).toBe("miss");
  });

  it("같은 시드면 같은 결과가 나온다", () => {
    const a = roll2d6(createSeededRng(42), 1);
    const b = roll2d6(createSeededRng(42), 1);
    expect(a).toEqual(b);
    expect(a.total).toBe(a.dice[0] + a.dice[1] + 1);
  });

  it("주사위 눈은 1~6 사이로 고르게 나온다", () => {
    const rng = createSeededRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const { dice } = roll2d6(rng, 0);
      for (const d of dice) {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(6);
        seen.add(d);
      }
    }
    expect(seen.size).toBe(6);
  });
});
