import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { exposeToFatigue, describeFatigue } from "./fatigue.ts";
import { runNaturalRecovery } from "./body.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 피로 (12-114): 깨어 있은 시간만큼 쌓이고 자면 풀린다 */
const content = { ...loadRealContent(), storylets: {} };
const H = 60;

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_l_wanderer", "world_fatigue", () => 0.5)]);
  const ctx = { store, rng: () => 0.99, content };
  const me = () => store.getState().characters[store.getState().playerId]!;
  const load = () => store.getState().fatigueLoad[store.getState().playerId] ?? 0;
  return { store, ctx, me, load };
}

describe("피로", () => {
  it("깨어 있으면 쌓여 16시간에 졸림, 24시간에 지침(-1), 32시간에 탈진(-2). 그 뒤로는 탈진에 머문다", () => {
    const { ctx, me, load } = setup();
    exposeToFatigue(ctx, "wait", 0, 15 * H);
    expect(me().conditions.fatigue).toBe("rested");
    exposeToFatigue(ctx, "wait", 15 * H, 16 * H);
    expect(me().conditions.fatigue).toBe("drowsy");
    exposeToFatigue(ctx, "wait", 16 * H, 24 * H);
    expect(me().conditions.fatigue).toBe("weary");
    exposeToFatigue(ctx, "wait", 24 * H, 40 * H);
    expect(me().conditions.fatigue).toBe("exhausted");
    expect(me().dead).toBe(false);
    expect(load()).toBe(40);
  });

  it("쉬기만 하면 더 쌓이지 않고, 자면 시간당 3씩 풀린다 (0 아래로는 내려가지 않는다)", () => {
    const { ctx, me, load } = setup();
    exposeToFatigue(ctx, "wait", 0, 24 * H);
    exposeToFatigue(ctx, "rest", 24 * H, 28 * H);
    expect(load()).toBe(24);
    exposeToFatigue(ctx, "sleep", 28 * H, 34 * H);
    expect(load()).toBe(6);
    expect(me().conditions.fatigue).toBe("rested");
    exposeToFatigue(ctx, "sleep", 34 * H, 40 * H);
    expect(load()).toBe(0);
  });

  it("레벨의 버팀으로 피하지 않는다 (깨어 있은 시간에서 바로 정해진다)", () => {
    const { ctx, store, me } = setup();
    store.getState().characters[store.getState().playerId]!.level = 20;
    exposeToFatigue({ ...ctx, rng: () => 0 }, "wait", 0, 24 * H);
    expect(me().conditions.fatigue).toBe("weary");
  });

  it("take_action의 잠이 피로를 풀고, 지친 동안은 판정 보정과 GM 상태의 한 줄로 보인다", () => {
    const { ctx, me, load } = setup();
    exposeToFatigue(ctx, "wait", 0, 25 * H);
    expect(describeFatigue(content, ctx.store.getState())).toContain("자면");
    const out = executeTool("take_action", { intent: "잔다", check: null, activity: { kind: "sleep", until: null }, deed: null, target: null, narration_summary: null, for_mission: false }, ctx);
    expect(out.ok).toBe(true);
    expect(load()).toBeLessThan(25);
    expect(me().conditions.fatigue).toBe("rested");
    expect(describeFatigue(content, ctx.store.getState())).toBeNull();
  });

  it("지친 동안은 상처가 저절로 낫지 않고, 자고 나면 밀린 만큼 낫는다 (12-115)", () => {
    const { ctx, store, me } = setup();
    const s = store.getState();
    s.time += 3 * 24 * H;
    s.characters[s.playerId]!.conditions.harm = "light";
    s.recovery.lastChangeAt[s.playerId] = s.time - 3 * 24 * H;
    exposeToFatigue(ctx, "wait", s.time - 25 * H, s.time);
    expect(me().conditions.fatigue).toBe("weary");
    runNaturalRecovery(ctx);
    expect(me().conditions.harm).toBe("light");
    expect(describeFatigue(content, store.getState())).toContain("저절로 낫지 않고");
    exposeToFatigue(ctx, "sleep", store.getState().time, store.getState().time + 6 * H);
    runNaturalRecovery(ctx);
    expect(me().conditions.harm).toBe("none");
  });

  it("몸을 쓰는 일은 더 지친다: 수색은 시간당 1.5, 전투는 3 (12-119)", () => {
    const { ctx, load } = setup();
    exposeToFatigue(ctx, "search", 0, 4 * H);
    expect(load()).toBe(6);
    exposeToFatigue(ctx, "combat", 4 * H, 5 * H);
    expect(load()).toBe(9);
    exposeToFatigue(ctx, "talk", 5 * H, 6 * H);
    expect(load()).toBe(10);
  });
});
