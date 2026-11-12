import { describe, expect, it } from "vitest";
import type { BattleState } from "../game/state.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { battleConfig, effectBlocker, finishWithoutPlayer, resolveRound, startBattle, wonBy } from "./battle.ts";
import { initialWarWorld, type ClashSpec } from "./war.ts";

const config = battleConfig(TEST_CONTENT);
const effect = (id: string) => config.effects.find((e) => e.id === id)!;
const spec: ClashSpec = { kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post" };
const even = { ours: 0, theirs: 0 };

function battle(overrides: Partial<BattleState> = {}): BattleState {
  return { ...startBattle(TEST_CONTENT, initialWarWorld(TEST_CONTENT), spec, "defense", { id: "battle_1", at: 0 }), ...overrides };
}

/** 배경 교전에서 항상 우리 편이 밀리게 (rng 0.99 → p보다 큼) */
const losing: Rng = () => 0.99;

describe("전투 시작", () => {
  it("방어 쪽이면 우리 편은 지키는 병력, 적은 공격 병력이다. 첫 위치·목표물은 시나리오에서", () => {
    const b = battle();
    // C 전투원 30 × 0.35 = 11, A 전투원 10 × 0.2 = 2
    expect(b.theirs).toEqual({ faction: "faction_c", committed: 11, losses: 0 });
    expect(b.ours).toEqual({ faction: "faction_a", committed: 2, losses: 0 });
    expect(b).toMatchObject({ momentum: 0, alarm: 0, position: "front", round: 0, objectives: ["boss", "stash"] });
  });
});

describe("효과 조건", () => {
  it("위치·경보·아이템·준비물을 검사한다", () => {
    const have = { items: {}, preparations: [] as string[] };
    expect(effectBlocker(effect("brawl"), battle(), have)).toBeNull();
    expect(effectBlocker(effect("backstab"), battle(), have)).toMatch(/위치/);
    expect(effectBlocker(effect("creep"), battle({ alarm: 2 }), have)).toMatch(/경계/);
    expect(effectBlocker(effect("blast"), battle({ position: "back" }), have)).toMatch(/bomb/);
    expect(effectBlocker(effect("blast"), battle({ position: "back" }), { items: { bomb: 1 }, preparations: [] })).toBeNull();
    expect(effectBlocker(effect("pull_snare"), battle(), have)).toMatch(/snare/);
    expect(effectBlocker(effect("pull_snare"), battle(), { items: {}, preparations: ["snare"] })).toBeNull();
    expect(effectBlocker(effect("blast"), battle({ position: "back", objectives: [] }), { items: { bomb: 1 }, preparations: [] })).toMatch(/목표물/);
  });
});

describe("라운드", () => {
  it("숨어들기 성공이면 한 칸 전진, 대가 있는 성공이면 경보도 오른다", () => {
    expect(resolveRound(TEST_CONTENT, battle(), { effect: effect("creep"), outcome: "success", objective: null }, even, losing).battle).toMatchObject({
      position: "back",
      alarm: 0,
    });
    expect(resolveRound(TEST_CONTENT, battle(), { effect: effect("creep"), outcome: "partial", objective: null }, even, losing).battle).toMatchObject({
      position: "back",
      alarm: 1,
    });
  });

  it("경보 0에서 기습하면 기습 보너스가 붙고, 기여로 남는다", () => {
    const quiet = resolveRound(TEST_CONTENT, battle({ position: "back" }), { effect: effect("backstab"), outcome: "success", objective: null }, even, losing);
    const loud = resolveRound(TEST_CONTENT, battle({ position: "back", alarm: 1 }), { effect: effect("backstab"), outcome: "success", objective: null }, even, losing);
    expect(quiet.delta).toBe(3);
    expect(loud.delta).toBe(2);
    expect(quiet.battle.contribution).toBe(3);
    expect(quiet.battle.alarm).toBe(3);
    expect(quiet.battle.theirs.losses).toBeGreaterThanOrEqual(2);
  });

  it("폭약은 고른 목표물을 무너뜨린다", () => {
    const r = resolveRound(TEST_CONTENT, battle({ position: "back" }), { effect: effect("blast"), outcome: "partial", objective: "stash" }, even, losing);
    expect(r.destroyed).toBe("stash");
    expect(r.battle.objectives).toEqual(["boss"]);
  });

  it("전세가 끝까지 가면 끝나고, 라운드가 다 되면 전세 부호로 (0이면 방어가 버틴다)", () => {
    const r = resolveRound(TEST_CONTENT, battle({ momentum: 3, position: "back" }), { effect: effect("backstab"), outcome: "success", objective: null }, even, losing);
    expect(r).toMatchObject({ ended: true, won: true });
    expect(r.battle.momentum).toBe(config.momentum_to_win); // 결정타: 배경 교전 없이 끝난다
    const last = resolveRound(TEST_CONTENT, battle({ round: config.max_rounds - 1, momentum: 1 }), null, even, losing);
    expect(last).toMatchObject({ ended: true });
    expect(wonBy({ ...battle(), momentum: 0 })).toBe(true);
    expect(wonBy({ ...battle(), side: "attack", momentum: 0 })).toBe(false);
  });

  it("물러나기에 성공하면 전투에서 빠진다", () => {
    const r = resolveRound(TEST_CONTENT, battle(), { effect: effect("run"), outcome: "success", objective: null }, even, losing);
    expect(r).toMatchObject({ withdrew: true, ended: true, won: null });
  });

  it("플레이어 없이 남은 라운드를 굴리면 끝에 이른다. 같은 시드면 같은 결과", () => {
    const a = finishWithoutPlayer(TEST_CONTENT, battle(), even, createSeededRng(9));
    const b = finishWithoutPlayer(TEST_CONTENT, battle(), even, createSeededRng(9));
    expect(a).toEqual(b);
    expect(Math.abs(a.momentum) >= config.momentum_to_win || a.round >= config.max_rounds).toBe(true);
  });

  it("입력 전투 상태를 바꾸지 않는다", () => {
    const b = battle();
    const before = JSON.stringify(b);
    resolveRound(TEST_CONTENT, b, { effect: effect("brawl"), outcome: "success", objective: null }, even, createSeededRng(1));
    expect(JSON.stringify(b)).toBe(before);
  });
});
