import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { fillStorylet } from "../story/storylets.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 긴 판 열 (플레이 테스트 11, 12-200) */
const storyletSchema = createContentSchemas(TEST_SCENARIO).storylet;

function setup(storylets: unknown[]) {
  const c: Content = structuredClone(TEST_CONTENT);
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = [];
  }
  c.scenario.storylet_pacing = { min_gap_hours: 6, expire_hours: 3, first_after_hours: 0, min_any_gap_hours: 0, urgent_per_day: 0, urgent_only_when: {}, per_day: 0, threat_per_day: 0, road_per_day: 0, same_threat_gap_days: 0 };
  c.storylets = Object.fromEntries(storylets.map((s) => storyletSchema.parse(s)).map((s) => [s.id, s]));
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng: createSeededRng(3), content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

const story = {
  id: "fallen",
  title: "꺼진 바닥",
  setup: "바닥이 꺼졌다.",
  choices: [
    { id: "help", label: "끌어낸다", effects: [] },
    { id: "leave", label: "두고 간다", effects: [{ set_flag: "left_them" }] },
  ],
};

describe("플레이 테스트 11 버그", () => {
  it("열린 이야기를 두고 떠나면 외면하는 선택지를 고른 것으로 푼다", () => {
    const env = setup([story]);
    expect(env.store.getState().activeStorylet?.id).toBe("fallen");
    const r = executeTool("take_action", act({ move_to: "a_post" }), env.ctx);
    expect(r.ok && r.resultText).toContain("두고 간다");
    const s = env.store.getState();
    expect(s.activeStorylet).toBeNull();
    expect(s.flags[s.playerId]).toContain("left_them");
  });

  it("외면하는 선택지가 없으면 지나갔다고 분명히 알린다", () => {
    const env = setup([{ ...story, choices: [story.choices[0]] }]);
    const r = executeTool("take_action", act({ move_to: "a_post" }), env.ctx);
    expect(r.ok && r.resultText).toContain("외면하고 자리를 떴다");
  });

  it("이야기를 둔 채 같은 자리에서 오래 걸리는 일은 거절하고, 모른 척하면 효과 없이 지나간다 (플레이 테스트 13)", () => {
    const env = setup([story]);
    const before = env.store.getState().time;
    const refused = executeTool("take_action", act({ activity: { kind: "wait", until: null } }), env.ctx);
    expect(!refused.ok && refused.error).toContain("ignore_story");
    expect(env.store.getState().time).toBe(before);
    const r = executeTool("take_action", act({ activity: { kind: "wait", until: null }, ignore_story: true }), env.ctx);
    expect(r.ok && r.resultText).toContain("모른 척했다");
    const s = env.store.getState();
    expect(s.activeStorylet).toBeNull();
    expect(s.flags[s.playerId] ?? []).not.toContain("left_them");
  });

  it("쓸 수 없는 물건은 판정·시간 전에 막는다", () => {
    const env = setup([]);
    const before = env.store.getState().time;
    env.store.getState().characters.player!.inventory.rope = 1;
    const r = executeTool("take_action", act({ use_item: "rope", check: null }), env.ctx);
    expect(r.ok).toBe(false);
    expect(env.store.getState().time).toBe(before);
  });

  it("호칭의 꾸밈말이 뒤에 또 나오면 끝 낱말만 쓴다", () => {
    expect(fillStorylet("{r:이/가} 빨간 털모자를 벗으며 웃는다.", { r: "빨간 털모자 쓴 심부름꾼" })).toBe("심부름꾼이 빨간 털모자를 벗으며 웃는다.");
    expect(fillStorylet("청솔형제단 의무실의 {r:이/가} 보낸 쪽지.", { r: "의무실 여자" })).toBe("청솔형제단 의무실의 여자가 보낸 쪽지.");
  });
});
