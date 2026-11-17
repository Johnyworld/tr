import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { disposition, HOSTILE } from "../sim/war.ts";
import { endExpiredTruces } from "./diplomacy.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { loadRealContent } from "../testing.ts";

/** 외교 (12-126) */
const content = { ...loadRealContent(), storylets: {} };
const level = (rank: string) => content.scenario.rank_ladder.find((r) => r.id === rank)?.level ?? 0;

function setup(role = "role_a_officer") {
  const roll = { value: 0.99 }; // 6+6: 성공
  const store = new InMemoryGameStore([createWorldEvent(content, role, "world_diplo", () => 0.5)]);
  const ctx = { store, rng: () => roll.value, content };
  runAfterTimeAdvance(ctx);
  const s = store.getState();
  const me = s.characters[s.playerId]!;
  // 붉은연합 간부 이상 한 사람을 장면에
  const envoy = Object.values(s.characters).find((c) => c.factionId === "faction_c" && !c.dead && !c.captive && level(c.rank) >= content.scenario.diplomacy!.envoy_level)!;
  s.scene.present = [envoy.id];
  return { store, ctx, roll, me, envoy, state: () => store.getState() };
}
const propose = (pact: string, envoy: string) => ({ pact, envoy, approach: "persuade", stat: "charm", intent: "서로 피를 그만 흘리자" });

describe("외교", () => {
  it("휴전: 받아들여지면 두 무리가 정한 날수 동안 적대 기준 위로 올라가고, 끝나면 원래대로", () => {
    const { ctx, me, envoy, state } = setup();
    const before = { ab: disposition(content, me.factionId, "faction_c", state()), ba: disposition(content, "faction_c", me.factionId, state()) };
    expect(before.ba).toBeLessThanOrEqual(HOSTILE);
    const out = executeTool("negotiate", propose("truce", envoy.id), ctx);
    expect(out.ok && out.resultText).toContain("휴전했다");
    expect(disposition(content, "faction_c", me.factionId, state())).toBeGreaterThan(HOSTILE);
    expect(disposition(content, me.factionId, "faction_c", state())).toBeGreaterThan(HOSTILE);
    expect(state().pacts).toHaveLength(1);
    // 이미 휴전 중
    expect(executeTool("negotiate", propose("truce", envoy.id), ctx).ok).toBe(false);
    // 기한이 지나면 원래 태도로
    state().time += 8 * MINUTES_PER_DAY;
    endExpiredTruces(ctx);
    expect(state().pacts).toHaveLength(0);
    expect(disposition(content, "faction_c", me.factionId, state())).toBe(before.ba);
    expect(disposition(content, me.factionId, "faction_c", state())).toBe(before.ab);
  });

  it("휴전 중에 그쪽 사람을 치면 휴전이 깨지고 배신으로 남는다", () => {
    const { ctx, envoy, me, state } = setup();
    executeTool("negotiate", propose("truce", envoy.id), ctx);
    const out = executeTool(
      "take_action",
      { intent: "친다", check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", target_harm: "light", distance: "close" }, activity: null, deed: null, target: envoy.id, narration_summary: null, for_mission: false },
      ctx,
    );
    expect(out.ok && out.resultText).toContain("휴전이 깨졌다");
    expect(state().pacts).toHaveLength(0);
    expect(disposition(content, "faction_c", me.factionId, state())).toBe(content.scenario.diplomacy!.broken);
    expect(Object.values(state().deeds).some((d) => d.tags.includes("betrayal"))).toBe(true);
  });

  it("포로 교환: 그쪽에 붙잡힌 우리 사람이 돌아온다. 없으면 꺼낼 수 없다", () => {
    const { ctx, envoy, me, state } = setup();
    // 콘텐츠에서 처음부터 붙잡혀 있는 사람은 풀어 두고 시작한다
    for (const c of Object.values(state().characters)) if (c.captive?.by === "faction_c" && c.factionId === me.factionId) c.captive = null;
    expect(executeTool("negotiate", propose("prisoner_exchange", envoy.id), ctx).ok).toBe(false);
    const ours = Object.values(state().characters).find((c) => c.factionId === me.factionId && c.id !== me.id && !c.dead && !c.captive)!;
    state().characters[ours.id]!.captive = { by: "faction_c", zone: "c_base" };
    const out = executeTool("negotiate", propose("prisoner_exchange", envoy.id), ctx);
    expect(out.ok && out.resultText).toContain("포로를 바꿨다");
    expect(state().characters[ours.id]!.captive).toBeNull();
  });

  it("거절당하면 며칠 다시 꺼내지 못하고 그쪽이 우리를 더 나쁘게 본다", () => {
    const { ctx, envoy, me, roll, state } = setup();
    roll.value = 0; // 1+1: 실패
    const before = disposition(content, "faction_c", me.factionId, state());
    const out = executeTool("negotiate", propose("truce", envoy.id), ctx);
    expect(out.ok && out.resultText).toContain("거절했다");
    expect(disposition(content, "faction_c", me.factionId, state())).toBe(Math.max(-3, before - 1));
    roll.value = 0.99;
    expect(executeTool("negotiate", propose("truce", envoy.id), ctx).ok).toBe(false);
  });

  it("간부가 아니면 무리를 대표해 협상하지 못한다", () => {
    const { ctx, envoy } = setup("role_a_grunt");
    const out = executeTool("negotiate", propose("truce", envoy.id), ctx);
    expect(out.ok).toBe(false);
  });
});
