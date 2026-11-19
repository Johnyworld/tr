import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentSchemas } from "../content/schemas.ts";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { campChance, campSite, describeCamp } from "./camp.ts";

/** 야영과 불침번 (12-148) */
const base = loadRealContent();
const parse = createContentSchemas(base.scenario).storylet.parse;
const watched = parse({
  id: "camp_watched_test",
  title: "지켜보는 밤",
  tags: ["camp"],
  when: { camp_watched: true },
  setup: "{zone}의 어둠에서 무언가 다가온다.",
  choices: [{ id: "pass", label: "지켜본다", effects: [] }],
});
const asleep = parse({
  id: "camp_asleep_test",
  title: "잠든 밤",
  tags: ["camp"],
  when: { camp_watched: false },
  setup: "{zone}에서 자다 깨니 무언가 곁에 있다.",
  choices: [{ id: "pass", label: "굳는다", effects: [] }],
});
const content = { ...base, storylets: { camp_watched_test: watched, camp_asleep_test: asleep } };
const make = (roll: number) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-camp-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
type World = ReturnType<typeof make>;
const act = (w: World, extra: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const go = (w: World, to: string) => act(w, { intent: "이동", move_to: to });
const spend = (w: World, kind: string) => act(w, { intent: kind, activity: { kind, until: null } });

describe("야영", () => {
  it("우리 거점은 지켜 주는 지붕이라 야영이 아니고, 바깥 구역은 야영이다", () => {
    const w = make(0);
    expect(campSite(content, w.state())).toBeNull();
    go(w, "old_town");
    expect(campSite(content, w.state())).not.toBeNull();
  });

  it("바깥에서 혼자 잠들면 아무도 지키지 않은 밤의 이야기가 잠을 끊는다", () => {
    const w = make(0);
    go(w, "old_town");
    const out = spend(w, "sleep");
    expect(w.state().activeStorylet?.id).toBe("camp_asleep_test");
    expect(out.ok && out.resultText).toContain("아무도 지키지 않고 잠들어 있었다");
  });

  it("지친 채로 잠들면 보초가 있어도 늦게 안다. 이야기는 그대로 열린다 (12-188)", () => {
    const w = make(0);
    go(w, "old_town");
    // 보초를 설 동행이 있다
    expect(w.runCheat("~summon a_jiho").ok).toBe(true);
    w.ctx().store.append({ type: "companion_joined", characterId: "a_jiho", kind: "purpose" });
    expect(w.runCheat("~set fatigue weary").ok).toBe(true);
    const out = spend(w, "sleep");
    expect(w.state().activeStorylet?.id).toBe("camp_asleep_test");
    expect(out.ok && out.resultText).toContain("흔들어 깨웠지만 몸이 무거워");
    expect(out.ok && out.resultText, out.ok ? out.resultText : out.error).toContain("깊이 잠들어 있었다");
  });

  it("깨어서 보초를 서면 지켜보는 밤의 이야기가 열린다", () => {
    const w = make(0);
    go(w, "old_town");
    const out = spend(w, "guard_duty");
    expect(w.state().activeStorylet?.id).toBe("camp_watched_test");
    expect(out.ok && out.resultText).toContain("먼저 알아챘다");
  });

  it("우리 거점에서 자면 야영의 이야기가 열리지 않는다", () => {
    const w = make(0);
    spend(w, "sleep");
    expect(w.state().activeStorylet).toBeNull();
  });

  it("확률을 넘기면 열리지 않는다", () => {
    const w = make(0.99);
    go(w, "old_town");
    spend(w, "sleep");
    expect(w.state().activeStorylet).toBeNull();
  });

  it("모닥불은 확률을 높이고, 우리 땅은 낮춘다", () => {
    const w = make(0.99);
    go(w, "old_town");
    const state = w.state();
    const site = campSite(content, state)!;
    const plain = campChance(content, state, { ...site, ownLand: false }, state.time);
    const lit = { ...state, fires: { old_town: state.time + 600 } };
    expect(campChance(content, lit, { ...site, ownLand: false }, state.time)).toBeCloseTo(plain * 1.5);
    expect(campChance(content, state, { ...site, ownLand: true }, state.time)).toBeCloseTo(plain * 0.5);
  });

  it("저녁·밤·새벽에 바깥이면 GM 상태에 잠자리 줄이 나온다 (숫자는 없다)", () => {
    const w = make(0.99);
    go(w, "old_town");
    const night = { ...w.state(), time: w.state().time - (w.state().time % 1440) + 22 * 60 };
    const line = describeCamp(content, night);
    expect(line).toContain("야영");
    expect(line).not.toMatch(/\d/);
  });
});
