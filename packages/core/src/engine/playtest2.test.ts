import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { createTestWorld, TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/**
 * 플레이 테스트 2회차(docs/playtests/2026-11-12-mcp-2.md)에서 찾은 문제의 회귀 테스트
 */
const storyletSchema = createContentSchemas(TEST_SCENARIO).storylet;

function content(storylets: unknown[], pacing = { min_gap_hours: 6, expire_hours: 3, first_after_hours: 0 }): Content {
  const c = structuredClone(TEST_CONTENT);
  for (const key of Object.keys(c.scenario.threats.disturbance_chance_per_hour)) {
    (c.scenario.threats.disturbance_chance_per_hour as Record<string, number>)[key] = 0;
  }
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = [];
  }
  c.scenario.storylet_pacing = pacing;
  c.storylets = Object.fromEntries(storylets.map((s) => storyletSchema.parse(s)).map((s) => [s.id, s]));
  return c;
}

function setup(c: Content, rng: Rng = createSeededRng(3)) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

const chat = {
  id: "chat",
  title: "잡담",
  cast: { boss: { commander: true } },
  setup: "{boss:이/가} 말을 건다.",
  choices: [{ id: "ok", label: "듣는다", effects: [] }],
};

describe("플레이 테스트 2회차 회귀", () => {
  it("P1: 세계를 열자마자 이야기가 끼어들지 않는다 (first_after_hours)", () => {
    const env = setup(content([chat], { min_gap_hours: 6, expire_hours: 3, first_after_hours: 2 }));
    expect(env.store.getState().activeStorylet).toBeNull();
    executeTool("take_action", act({ activity: { kind: "work", until: null } }), env.ctx);
    expect(env.store.getState().activeStorylet?.id).toBe("chat");
  });

  it("P14·P13: 다른 구역으로 가면 장면의 인물은 따라오지 않고, 그 자리의 이야기도 끝난다", () => {
    const env = setup(content([chat]));
    expect(env.store.getState().scene.present).toContain("npc_leader");
    executeTool("take_action", act({ move_to: "a_post" }), env.ctx);
    const s = env.store.getState();
    expect(s.scene.present).toEqual([]);
    expect(s.activeStorylet).toBeNull();
  });

  it("P10: 시간이 지나 이야기가 끝나면 이야기 때문에 들어온 배역은 떠난다", () => {
    const env = setup(content([chat]));
    executeTool("take_action", act({ activity: { kind: "work", until: null } }), env.ctx);
    executeTool("take_action", act({ activity: { kind: "work", until: null } }), env.ctx);
    const s = env.store.getState();
    expect(s.activeStorylet).toBeNull();
    expect(s.scene.present).not.toContain("npc_leader");
  });

  it("P11: 자는 동안에는 급한 이야기만 잠을 깨운다", () => {
    const calm = setup(content([{ ...chat, when: { segments: ["night"] } }]));
    executeTool("take_action", act({ activity: { kind: "wait", until: "evening" } }), calm.ctx);
    executeTool("take_action", act({ activity: { kind: "sleep", until: "morning" } }), calm.ctx);
    expect(calm.store.getState().time % MINUTES_PER_DAY).toBe(6 * 60); // 아침까지 잤다
    const urgent = setup(content([{ ...chat, urgent: true, when: { segments: ["night"] } }]));
    executeTool("take_action", act({ activity: { kind: "wait", until: "evening" } }), urgent.ctx);
    executeTool("take_action", act({ activity: { kind: "sleep", until: "morning" } }), urgent.ctx);
    expect(urgent.store.getState().activeStorylet?.id).toBe("chat");
    expect(urgent.store.getState().time % MINUTES_PER_DAY).not.toBe(6 * 60);
  });

  it("P22: 다음 캐릭터 후보는 같은 무리 사람만", () => {
    const world = createTestWorld("mcp", () => 0);
    world.executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }); // 다른 무리 사람을 알게 된다
    const deadly = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "총상" };
    for (let i = 0; i < 3 && !world.isPlayerDead(); i++) world.executeTool("take_action", act({ check: deadly }));
    TEST_CONTENT.npcs.npc_stranger!.playable = true;
    try {
      expect(world.successionOptions().map((o) => o.id)).toEqual(["new", "npc_leader"]);
    } finally {
      TEST_CONTENT.npcs.npc_stranger!.playable = false;
    }
  });

  it("P16: 적대 세력의 땅에 있으면 GM 컨텍스트가 알려 준다", () => {
    const env = setup(content([]));
    env.store.append({ type: "zone_moved", from: "a_home", to: "c_home" });
    expect(describePlayerState(env.store.getState(), TEST_CONTENT)).toContain("적대 세력의 땅");
  });
});
