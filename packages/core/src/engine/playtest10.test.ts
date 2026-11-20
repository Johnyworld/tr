import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { fillStorylet } from "../story/storylets.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 긴 판 버그 (플레이 테스트 10, 12-197) */
const storyletSchema = createContentSchemas(TEST_SCENARIO).storylet;

function content(storylets: unknown[]): Content {
  const c = structuredClone(TEST_CONTENT);
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = [];
  }
  c.scenario.storylet_pacing = { min_gap_hours: 6, expire_hours: 3, first_after_hours: 0, min_any_gap_hours: 0, urgent_per_day: 0, urgent_only_when: {}, per_day: 0, threat_per_day: 0, road_per_day: 0, same_threat_gap_days: 0 };
  c.storylets = Object.fromEntries(storylets.map((s) => storyletSchema.parse(s)).map((s) => [s.id, s]));
  return c;
}

function setup(c: Content) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng: createSeededRng(3), content: c };
  return { store, ctx };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

const night = { id: "night_talk", title: "밤 이야기", when: { segments: ["night"] }, setup: "누가 말을 건다.", choices: [{ id: "ok", label: "듣는다", effects: [] }] };

describe("플레이 테스트 10 버그", () => {
  it("C1: 자정을 넘기는 잠 도중에는 보통 이야기가 열렸다 사라지지 않는다", () => {
    const env = setup(content([night]));
    // 저녁까지 기다린 뒤 아침까지 잔다: 자정의 하루 처리에서 이야기를 열지 않는다
    executeTool("take_action", act({ activity: { kind: "wait", until: "evening" } }), env.ctx);
    const before = env.store.getState().storyletLog.night_talk?.fired ?? 0;
    const opened = env.store.getState().activeStorylet?.id === "night_talk";
    executeTool("take_action", act({ activity: { kind: "sleep", until: "morning" } }), env.ctx);
    const s = env.store.getState();
    // 자는 동안 열렸다면 깨워서 보여 줬어야 한다: 열린 횟수가 늘었는데 지금 진행 중이 아니면 안 된다
    const fired = (s.storyletLog.night_talk?.fired ?? 0) - before;
    if (!opened) expect(fired === 0 || s.activeStorylet?.id === "night_talk").toBe(true);
    expect(s.time % MINUTES_PER_DAY).toBeGreaterThan(0);
  });

  it("C4: 호칭이 앞말과 겹치면 접는다 (이름은 그대로)", () => {
    expect(fillStorylet("지도통을 멘 {m:이/가} 다가온다.", { m: "지도통을 멘 소식장수" })).toBe("지도통을 멘 소식장수가 다가온다.");
    expect(fillStorylet("늙은 신부 {p:은/는} 웃었다.", { p: "늙은 신부" })).toBe("늙은 신부는 웃었다.");
    expect(fillStorylet("규율반원 {p}에게 묻는다.", { p: "박달나무 몽둥이를 찬 규율반원" })).toBe("규율반원에게 묻는다.");
    expect(fillStorylet("허리에 쇠 저울추를 단 {b:이/가} 손짓한다.", { b: "쇠 저울추를 찬 행상대장" })).toBe("허리에 쇠 저울추를 단 행상대장이 손짓한다.");
    expect(fillStorylet("{b:이/가} 손짓한다.", { b: "쇠 저울추를 찬 행상대장" })).toBe("쇠 저울추를 찬 행상대장이 손짓한다.");
    expect(fillStorylet("늙은 신부 {p:은/는} 웃었다.", { p: "피정호" })).toBe("늙은 신부 피정호는 웃었다.");
  });
});
