import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import {
  applyRelationDelta,
  computeRelationDelta,
  hiddenWitnessChance,
  NEUTRAL_RELATION,
  spreadOneDay,
  TALKATIVE_FACTOR,
  type Deed,
} from "./reputation.ts";

const taeho = { discipline: 3, loyalty: 2, mercy: -1, honesty: 1, self_interest: -1 };
const mansu = { discipline: -1, loyalty: 2, mercy: 1, honesty: 0, self_interest: 1 };

describe("관계 변화량", () => {
  it("같은 행동도 가치관에 따라 반대로 받아들인다", () => {
    const pity = computeRelationDelta(taeho, ["mercy"], 2, "seen");
    const pityMansu = computeRelationDelta(mansu, ["mercy"], 2, "seen");
    expect(pity.affection).toBeLessThan(0);
    expect(pityMansu.affection).toBeGreaterThan(0);
  });

  it("규율을 중시하는 상관은 불복종에 크게 실망한다", () => {
    expect(computeRelationDelta(taeho, ["disobedience"], 2, "seen")).toEqual({ trust: -2, affection: 0, respect: -2 });
    expect(computeRelationDelta(mansu, ["disobedience"], 2, "seen").trust).toBeGreaterThanOrEqual(0);
  });

  it("직접 본 것 > 전해 들은 것 > 소문", () => {
    const seen = computeRelationDelta(taeho, ["disobedience"], 3, "seen").trust;
    const report = computeRelationDelta(taeho, ["disobedience"], 3, "report").trust;
    const rumor = computeRelationDelta(taeho, ["disobedience"], 3, "rumor").trust;
    expect(seen).toBeLessThan(report);
    expect(report).toBeLessThan(rumor);
  });

  it("도둑질은 정직을 중시하지 않는 사람에게도 신뢰를 잃는다 (부호 회귀 테스트)", () => {
    expect(computeRelationDelta({ honesty: 0 }, ["theft"], 2, "seen").trust).toBeLessThan(0);
    expect(computeRelationDelta({ honesty: 3 }, ["theft"], 2, "seen").trust).toBeLessThan(
      computeRelationDelta({ honesty: 0 }, ["theft"], 2, "seen").trust,
    );
  });

  it("가치관과 무관한 몫(용기)은 누구나 반응하고, 한 번에 최대 3까지 움직인다", () => {
    expect(computeRelationDelta({}, ["bravery"], 1, "seen").respect).toBeGreaterThan(0);
    const big = computeRelationDelta(taeho, ["disobedience", "betrayal", "cruelty"], 3, "seen");
    expect(Math.min(big.trust, big.affection, big.respect)).toBeGreaterThanOrEqual(-3);
  });

  it("관계는 -5 ~ +5 안에 머문다", () => {
    expect(applyRelationDelta({ ...NEUTRAL_RELATION, trust: 4 }, { trust: 3, affection: 0, respect: 0 }).trust).toBe(5);
  });
});

describe("숨은 목격자 확률", () => {
  const base = { privacy: "public" as const, time: 12 * 60, noisy: false, senseStat: 0, stealth: null };
  it("공개된 곳·낮·소음은 높이고, 은밀 행동 성공은 낮춘다", () => {
    const p = hiddenWitnessChance(base);
    expect(hiddenWitnessChance({ ...base, privacy: "private" })).toBeLessThan(p);
    expect(hiddenWitnessChance({ ...base, time: 23 * 60 })).toBeLessThan(p);
    expect(hiddenWitnessChance({ ...base, noisy: true })).toBeGreaterThan(p);
    expect(hiddenWitnessChance({ ...base, stealth: "success" })).toBeLessThan(hiddenWitnessChance({ ...base, stealth: "partial" }));
    expect(hiddenWitnessChance({ ...base, noisy: true, senseStat: 3 })).toBeLessThanOrEqual(0.95);
  });
});

describe("소문 전파", () => {
  const deed: Deed = {
    id: "d_1",
    actorId: "player",
    summary: "창고에서 통조림을 훔쳤다",
    tags: ["theft"],
    severity: 2,
    at: 0,
    witnesses: [],
    searched: false,
  };

  it("하루에 한 단계만 퍼지고 출처가 흐려진다", () => {
    const always = () => 0;
    const learned = spreadOneDay({
      deeds: [deed],
      knowledge: { a: { d_1: "seen" } },
      npcIds: ["a", "b", "c"],
      spreadFactor: () => 1,
      rng: always,
    });
    expect(learned).toEqual([
      { deedId: "d_1", npcId: "b", source: "report" },
      { deedId: "d_1", npcId: "c", source: "report" },
    ]);
  });

  it("소문은 더 퍼지지 않는다", () => {
    const learned = spreadOneDay({
      deeds: [deed],
      knowledge: { a: { d_1: "rumor" } },
      npcIds: ["a", "b"],
      spreadFactor: () => TALKATIVE_FACTOR,
      rng: () => 0,
    });
    expect(learned).toEqual([]);
  });

  it("말 많은 사람이 더 잘 퍼뜨린다", () => {
    const rate = (talkative: boolean) => {
      const rng = createSeededRng(5);
      let n = 0;
      for (let i = 0; i < 2000; i++) {
        n += spreadOneDay({
          deeds: [deed],
          knowledge: { a: { d_1: "seen" } },
          npcIds: ["a", "b"],
          spreadFactor: () => (talkative ? TALKATIVE_FACTOR : 1),
          rng,
        }).length;
      }
      return n / 2000;
    };
    expect(rate(true)).toBeGreaterThan(rate(false) * 1.6);
  });
});
