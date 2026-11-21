import { storyFits } from "../rules/situation.ts";
import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createTestStore, TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { inCrisis, pacingBlocks, storyletAllowed } from "../story/storylets.ts";
import { runAlarm } from "./storyletTools.ts";

/** 균형 D (플레이 테스트 11): 하루 이야기 상한, 위협 하루 하나, 길 위의 일 하루 하나, 같은 위협 간격 */
const schema = createContentSchemas(TEST_SCENARIO).storylet;
const story = (id: string, extra: Record<string, unknown> = {}) => schema.parse({ id, title: id, setup: "x", choices: [{ id: "a", label: "a", effects: [] }], ...extra });

function world(edit: (c: Content) => void) {
  const c: Content = structuredClone(TEST_CONTENT);
  c.scenario.storylet_pacing = { ...c.scenario.storylet_pacing, per_day: 3, threat_per_day: 1, road_per_day: 1, same_threat_gap_days: 2 };
  c.scenario.travel = { ...(c.scenario.travel ?? {}), tag: "road" } as never;
  edit(c);
  const store = createTestStore();
  const fire = (id: string) => (store.getState().storyletLog[id] = { fired: 1, lastFiredAt: store.getState().time });
  return { c, store, fire };
}

describe("균형 D: 이야기 상한", () => {
  it("하루 세 개, 위협은 하루 하나, 같은 위협은 이틀 뒤", () => {
    const { c, store, fire } = world((c) => {
      for (const s of [story("a"), story("b"), story("c"), story("d"), story("scary1", { fright: 1, fright_tags: ["dark"] }), story("scary2", { fright: 1, fright_tags: ["dark"] })]) c.storylets[s.id] = s;
    });
    const t = store.getState().time;
    fire("scary1");
    expect(pacingBlocks(store.getState(), c, c.storylets.scary2!, t)).toBe(true);
    expect(pacingBlocks(store.getState(), c, c.storylets.a!, t)).toBe(false);
    fire("a");
    fire("b");
    expect(pacingBlocks(store.getState(), c, c.storylets.c!, t)).toBe(true);
    // 다음 날: 상한은 풀리지만 같은 위협(dark)은 이틀이 지나야
    expect(pacingBlocks(store.getState(), c, c.storylets.c!, t + 24 * 60)).toBe(false);
    expect(pacingBlocks(store.getState(), c, c.storylets.scary2!, t + 24 * 60)).toBe(true);
    expect(pacingBlocks(store.getState(), c, c.storylets.scary2!, t + 2 * 24 * 60)).toBe(false);
  });

  it("임무 자리의 이야기는 상한에 걸리지 않는다", () => {
    const { c, store, fire } = world((c) => {
      for (const s of [story("a"), story("b"), story("c"), story("m", { when: { mission: ["m_guard"] } })]) c.storylets[s.id] = s;
    });
    for (const id of ["a", "b", "c"]) fire(id);
    expect(pacingBlocks(store.getState(), c, c.storylets.m!, store.getState().time)).toBe(false);
  });

  it("누워 있는 동안의 이야기는 위급할 때도 열린다 (D4)", () => {
    const { c, store } = world((c) => {
      c.scenario.storylet_pacing = { ...c.scenario.storylet_pacing, urgent_only_when: { [c.scenario.harm_track]: c.scenario.condition_tracks.find((t) => t.id === c.scenario.harm_track)!.levels[1]!.id } };
      c.storylets.bed = story("bed", { bedside: true });
      c.storylets.plain = story("plain");
    });
    const s = store.getState();
    s.characters[s.playerId]!.conditions[c.scenario.harm_track] = c.scenario.condition_tracks.find((t) => t.id === c.scenario.harm_track)!.levels[1]!.id;
    expect(inCrisis(s, c)).toBe(true);
    // 정말 누워 있을 때만 (플레이 테스트 13): 처지 규칙 (rules/situation.ts)
    expect(storyFits(c.storylets.bed!, { ...s, lastActivity: "guard_duty" }, c)).toBe(false);
    s.lastActivity = "rest";
    expect(storyFits(c.storylets.bed!, s, c)).toBe(true);
    expect(storyletAllowed(s, c, c.storylets.bed!, "urgent_only", s.time)).toBe(true);
    expect(storyletAllowed(s, c, c.storylets.plain!, "urgent_only", s.time)).toBe(false);
  });

  it("적대하는 무리의 땅에서 숨기가 실패하면 경보 이야기가 열린다 (D6)", () => {
    const { c, store } = world((c) => {
      c.scenario.alarm = { tag: "alarm", moves: ["stealth"] };
      c.storylets.caught = story("caught", { tags: ["alarm"] });
    });
    const ctx = { store, rng: () => 0, content: c };
    expect(runAlarm(ctx, "stealth")).toEqual([]); // 우리 땅
    const st = store.getState();
    st.playerZone = "c_home";
    st.zones = { ...st.zones, c_home: { ...(st.zones.c_home ?? {}), owner: "faction_c" } as never };
    st.factions = { ...st.factions, faction_c: { ...(st.factions.faction_c ?? {}), disposition: { faction_a: -3 } } as never };
    expect(runAlarm(ctx, "sense_danger")).toEqual([]);
    const out = runAlarm(ctx, "stealth");
    expect(out.some((d) => d.type === "storylet")).toBe(true);
    expect(store.getState().activeStorylet?.id).toBe("caught");
  });
});
