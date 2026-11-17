import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { dayOf, MINUTES_PER_DAY, SEGMENT_START_HOUR } from "../rules/time.ts";
import { initialWarWorld } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { exposeToCold, feelsLike, outsideTemp } from "./climate.ts";
import { autoEquip } from "./gear.ts";
import { executeTool } from "./tools.ts";
import { fireStorylet } from "./storyletTools.ts";
import { loadRealContent } from "../testing.ts";

/** 기온 (12-98) */
const content = loadRealContent();
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

/** 겨울 어느 날 hour시, zone에 있는 주인공 (날씨 없음, 동행 없음, 트레잇 없음, 빈손) */
function setup(opts: { hour?: number; zone?: string; role?: string; season?: string; quiet?: boolean } = {}) {
  // quiet: 이야기·끼어들기 없이 시간만 흐른다
  const c = opts.quiet ? { ...content, storylets: {} } : content;
  const store = new InMemoryGameStore([createWorldEvent(c, opts.role ?? "role_l_wanderer", "world_cold", () => 0.5)]);
  const ctx = { store, rng: () => 0.5, content: c };
  const state = store.getState();
  let day = Math.floor(state.time / MINUTES_PER_DAY);
  while (seasonAt(content.scenario, day * MINUTES_PER_DAY)?.label !== (opts.season ?? "겨울")) day++;
  state.time = day * MINUTES_PER_DAY + (opts.hour ?? 12) * 60;
  state.weather = null;
  state.playerZone = opts.zone ?? "old_town";
  const me = () => store.getState().characters[store.getState().playerId]!;
  me().traits = [];
  me().inventory = {};
  me().equipped = { weapon: null, body: null, head: null, arms: null, outer: null };
  me().conditions.cold = "warm";
  store.getState().companions = [];
  return { store, ctx, me };
}

describe("기온", () => {
  it("밤이 낮보다 춥고, 같은 날 같은 시각은 늘 같다", () => {
    const night = setup({ hour: SEGMENT_START_HOUR.night + 1 });
    const day = setup({ hour: SEGMENT_START_HOUR.day + 1 });
    const n = outsideTemp(content, night.store.getState())!;
    const d = outsideTemp(content, day.store.getState())!;
    expect(n.value).toBeLessThan(d.value);
    expect(outsideTemp(content, night.store.getState())!.value).toBe(n.value);
    // 가을 낮은 겨울 낮보다 따뜻하다
    expect(outsideTemp(content, setup({ season: "가을" }).store.getState())!.value).toBeGreaterThan(d.value);
  });

  it("체감: 실내는 바깥보다 따뜻하고, 방한복은 입어야, 담요는 자거나 쉴 때만", () => {
    const { store, me } = setup();
    const out = feelsLike(content, store.getState(), "search")!;
    const inside = feelsLike(content, store.getState(), "rest")!;
    expect(inside.value).toBeGreaterThan(out.value);
    expect(inside.indoor).toBe(true);
    me().inventory.coat = 1;
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value); // 가방에만 있다
    me().equipped.outer = "coat";
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value + 6);
    me().inventory.blanket = 1;
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value + 6);
    expect(feelsLike(content, store.getState(), "sleep")!.value).toBe(inside.value + 6 + 5);
  });

  it("덮을 곳이 없는 구역은 쉬어도 바깥", () => {
    const { store } = setup({ zone: "overpass" });
    const f = feelsLike(content, store.getState(), "sleep")!;
    expect(f.indoor).toBe(false);
    expect(f.value).toBe(outsideTemp(content, store.getState())!.value);
  });

  it("겨울밤을 맨몸으로 바깥에서 보내면 추위가 오르고, 따뜻한 곳에서 쉬면 풀린다", () => {
    const { ctx, store, me } = setup({ hour: SEGMENT_START_HOUR.night, zone: "overpass" });
    const t = store.getState().time;
    exposeToCold(ctx, "wait", t, t + 8 * 60);
    expect(me().conditions.cold).not.toBe("warm");
    const cold = me().conditions.cold;
    // 모닥불 곁의 실내에서 쉰다
    store.getState().playerZone = "old_town";
    store.getState().fires.old_town = t + 20 * 60;
    me().inventory.blanket = 1;
    exposeToCold(ctx, "rest", t + 8 * 60, t + 14 * 60);
    expect(me().conditions.cold).not.toBe(cold);
  });

  it("연료가 바닥난 우리 거점 실내에서는 거점 사람들처럼 오한에서 멈춘다. 바깥은 계속 나빠진다 (12-138)", () => {
    const { ctx, store, me } = setup({ hour: SEGMENT_START_HOUR.night, zone: "a_base", role: "role_a_grunt", quiet: true });
    const w = initialWarWorld(content);
    store.getState().factions = w.factions;
    store.getState().zones = w.zones;
    store.getState().playerZone = "a_base";
    store.getState().factions.faction_a!.resources.fuel = 0;
    me().factionId = "faction_a";
    const t = store.getState().time;
    for (let h = 0; h < 10; h++) exposeToCold(ctx, "rest", t + h * 6 * 60, t + (h + 1) * 6 * 60);
    expect(me().conditions.cold).toBe(content.scenario.body!.residents!.cold_max);
    expect(me().dead).toBe(false);
    // 한도에 걸린 냉기를 쌓아 두지 않아, 밖에 나가도 한꺼번에 여러 단계가 떨어지지 않는다
    expect(store.getState().coldLoad[me().id] ?? 0).toBeLessThan(content.scenario.body!.cold!.climate!.per_step);
    // 담 밖 바깥에서는 한도가 없다
    store.getState().playerZone = "overpass";
    for (let h = 10; h < 14; h++) exposeToCold(ctx, "wait", t + h * 6 * 60, t + (h + 1) * 6 * 60);
    expect(me().conditions.cold).not.toBe(content.scenario.body!.residents!.cold_max);
  });

  it("땔감으로 불을 피우면 연료가 줄고, 그 구역이 따뜻해지고, 소음이 난다", () => {
    const { ctx, store, me } = setup({ hour: SEGMENT_START_HOUR.night });
    me().inventory.firewood = 1;
    const before = feelsLike(content, store.getState(), "rest")!.value;
    const out = executeTool("take_action", act({ use_item: "firewood" }), ctx);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.resultText).toContain("불을 피웠다");
    expect(me().inventory.firewood ?? 0).toBe(0);
    expect(store.getState().fires.old_town).toBeGreaterThan(store.getState().time);
    expect(feelsLike(content, store.getState(), "rest")!.parts.join()).toContain("모닥불");
    expect(feelsLike(content, store.getState(), "rest")!.value).toBeGreaterThanOrEqual(before + 9);
    expect(store.getState().zoneNoise.old_town?.level).toBeGreaterThan(0);
  });

  it("take_action으로 시간을 흘리면 GM에게 추위의 까닭(기온·체감)이 간다", () => {
    const { ctx, me } = setup({ hour: SEGMENT_START_HOUR.evening, zone: "overpass", quiet: true });
    const out = executeTool("take_action", act({ activity: { kind: "wait", until: "dawn" } }), ctx);
    expect(out.ok).toBe(true);
    expect(me().conditions.cold).not.toBe("warm");
    if (out.ok) expect(out.resultText).toMatch(/추위: .*바깥 -?\d+°.*체감 -?\d+°/);
  });

  it("방한복을 가지고 시작하면 외투 칸에 입는다", () => {
    const { ctx, me } = setup();
    me().inventory.coat = 1;
    autoEquip(ctx, me().id);
    expect(me().equipped.outer).toBe("coat");
  });

  it("다른 무리 거점도 우리를 나쁘게 보지 않으면 불 땐 방에 재워 준다. 적대하는 무리는 아니다 (12-121)", () => {
    const at = (zone: string) => {
      const { store } = setup({ zone, role: "role_a_grunt", hour: SEGMENT_START_HOUR.night + 1 });
      const w = initialWarWorld(content);
      store.getState().factions = w.factions;
      store.getState().zones = w.zones;
      return feelsLike(content, store.getState(), "sleep")!;
    };
    expect(at("b_base").parts).toContain("불 땐 거처"); // 버들마을은 청솔을 좋게 본다
    expect(at("c_base").parts).not.toContain("불 땐 거처"); // 붉은연합은 적
  });

  it("비 오는 날 바깥에 있으면 옷이 젖어 몇 시간 춥고, 모닥불 곁에서는 마른다 (12-121)", () => {
    const { store, ctx, me } = setup({ hour: SEGMENT_START_HOUR.day + 1 });
    const s = store.getState();
    s.weather = { day: dayOf(s.time), id: "rain" };
    const wet = content.scenario.body!.cold!.climate!.wet!;
    exposeToCold(ctx, "search", s.time, s.time + 60);
    const until = store.getState().wetUntil[me().id]!;
    expect(until).toBe(s.time + 60 + wet.hours * 60);
    // 비가 그친 뒤에도 젖어 있는 동안은 실내에서도 춥다
    store.getState().weather = null;
    store.getState().time = s.time + 90;
    const f = feelsLike(content, store.getState(), "rest")!;
    expect(f.parts).toContain(`젖은 옷 -${wet.degrees}`);
    // 모닥불 곁에서는 한 시간이면 마른다
    store.getState().fires[store.getState().playerZone!] = store.getState().time + 240;
    exposeToCold(ctx, "rest", store.getState().time, store.getState().time + 60);
    expect(store.getState().wetUntil[me().id]).toBeLessThanOrEqual(store.getState().time + 60);
    store.getState().fires = {};
    store.getState().time += 120;
    expect(feelsLike(content, store.getState(), "rest")!.parts.some((p) => p.startsWith("젖은 옷"))).toBe(false);
  });

  it("이야기에서 물에 빠지면 젖는다 (soak)", () => {
    const { store, ctx, me } = setup({ quiet: true });
    const base = content.storylets.wg_gunshot_wave!;
    const story = { ...base, cast: {}, choices: [{ id: "x", label: "x", effects: [{ soak: true as const }] }] };
    const c = { ...ctx, content: { ...ctx.content, storylets: { ...ctx.content.storylets, [story.id]: story } } };
    fireStorylet(c, story as never, {});
    const out = executeTool("resolve_storylet", { choice_id: "x" }, c);
    expect(out.ok && out.resultText).toContain("젖었다");
    expect(store.getState().wetUntil[me().id]).toBeGreaterThan(store.getState().time);
  });

  it("함께 다니는 사람도 같은 추위를 겪는다. 옷과 체질은 그 사람의 것 (12-122)", () => {
    const { store, ctx } = setup({ hour: SEGMENT_START_HOUR.night + 1, zone: "overpass" });
    const s = store.getState();
    const [bare, dressed] = Object.keys(content.npcs).filter((id) => !s.characters[id]!.dead).slice(0, 2);
    for (const id of [bare!, dressed!]) {
      const c = s.characters[id]!;
      c.traits = [];
      c.inventory = {};
      c.conditions.cold = "warm";
    }
    s.characters[dressed!]!.inventory = { coat: 1 };
    s.companions = [bare!, dressed!];
    exposeToCold(ctx, "guard_duty", s.time, s.time + 12 * 60);
    const after = store.getState();
    const idx = (id: string) => content.scenario.condition_tracks.find((t) => t.id === "cold")!.levels.findIndex((l) => l.id === after.characters[id]!.conditions.cold);
    expect(idx(bare!)).toBeGreaterThan(0);
    expect(idx(dressed!)).toBeLessThan(idx(bare!));
    expect(feelsLike(content, after, "guard_duty", after.time, dressed!)!.parts.some((p) => p.includes("방한복"))).toBe(true);
  });

  it("성당·캠퍼스 같은 피난처의 실내는 거점보다는 춥지만 얼지 않는다 (12-122)", () => {
    const { store } = setup({ zone: "cathedral", hour: SEGMENT_START_HOUR.night + 1 });
    store.getState().weather = { day: dayOf(store.getState().time), id: "cold_snap" };
    const f = feelsLike(content, store.getState(), "sleep")!;
    expect(f.parts).toContain("피난처의 난로");
    expect(f.value).toBe(content.scenario.body!.cold!.climate!.sanctuary);
    // 바깥에서 보초를 서면 그대로 춥다
    expect(feelsLike(content, store.getState(), "guard_duty")!.parts).not.toContain("피난처의 난로");
  });
});
