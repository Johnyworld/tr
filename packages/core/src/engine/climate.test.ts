import { fireSpot } from "../rules/place.ts";
import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { dayOf, MINUTES_PER_DAY, SEGMENT_START_HOUR } from "../rules/time.ts";
import { initialWarWorld } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { exposeToCold, feelsLike, outsideTemp, wetDegrees } from "./climate.ts";
import { autoEquip } from "./gear.ts";
import { executeTool } from "./tools.ts";
import { fireStorylet } from "./storyletTools.ts";
import { loadRealContent } from "../testing.ts";

/** 기온 (12-98) */
const content = loadRealContent();
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

/** 겨울 어느 날 hour시, zone에 있는 주인공 (날씨 없음, 동행 없음, 트레잇 없음, 빈손) */
/** 이 구역의 실내 장소 (막 들어선 자리는 바깥이다, 12-261) */
const indoorOf = (zone: string) => content.locations[zone]?.places.find((p) => p.indoor && !p.jail)?.id ?? null;

function setup(opts: { hour?: number; zone?: string; role?: string; season?: string; quiet?: boolean; entry?: boolean } = {}) {
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
  // 지붕 아래에서 쉬는 셈은 실내 장소에서 (막 들어선 자리는 바깥이다, 12-261)
  state.playerPlace = opts.entry ? null : indoorOf(state.playerZone);
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
    const { store, me } = setup({ entry: true });
    const out = feelsLike(content, store.getState(), "search")!;
    store.getState().playerPlace = indoorOf("old_town");
    const inside = feelsLike(content, store.getState(), "rest")!;
    store.getState().playerPlace = null;
    expect(inside.value).toBeGreaterThan(out.value);
    expect(inside.indoor).toBe(true);
    me().inventory.coat = 1;
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value); // 가방에만 있다
    me().equipped.outer = "coat";
    const coat = content.items.coat!.warmth!.degrees;
    const blanket = content.items.blanket!.warmth!.degrees;
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value + coat);
    me().inventory.blanket = 1;
    expect(feelsLike(content, store.getState(), "search")!.value).toBe(out.value + coat);
    store.getState().playerPlace = indoorOf("old_town");
    expect(feelsLike(content, store.getState(), "sleep")!.value).toBe(inside.value + coat + blanket);
  });

  it("덮을 곳이 없는 구역은 쉬어도 바깥", () => {
    // 12-304: 고가도로에 실내 장소(고가 옆 상가)가 생겨 실내가 없는 길목 강둑 북길로
    const { store } = setup({ zone: "north_levee" });
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
    store.getState().fires[fireSpot(store.getState())!] = t + 20 * 60;
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
    expect(store.getState().fires[fireSpot(store.getState())!]).toBeGreaterThan(store.getState().time);
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
      // 손님은 안에 들어가 잔다: 남의 거점에 막 들어선 자리는 담 밖 문 앞이다 (12-260)
      store.getState().playerPlace = content.locations[zone]!.places.find((p) => p.indoor && !p.jail)!.id;
      return feelsLike(content, store.getState(), "sleep")!;
    };
    expect(at("b_base").parts.some((p) => p.startsWith("불 땐 거처"))).toBe(true); // 버들마을은 청솔을 좋게 본다
    expect(at("c_base").parts.some((p) => p.startsWith("불 땐 거처"))).toBe(false); // 붉은연합은 적
  });

  it("비 오는 날 바깥에 있으면 옷이 젖는다. 바깥에서는 마르지 않고, 지붕 아래 네 시간·불 곁 두 시간이면 마른다 (12-121, 12-186, 12-251)", () => {
    const { store, ctx, me } = setup({ hour: SEGMENT_START_HOUR.day + 1, entry: true });
    const s = store.getState();
    s.weather = { day: dayOf(s.time), id: "rain" };
    const wet = content.scenario.body!.cold!.climate!.wet!;
    const shown = exposeToCold(ctx, "search", s.time, s.time + 60);
    expect(store.getState().wet[me().id]).toBe(wet.fire_hours * 60);
    expect(shown.some((d) => d.type === "harm" && d.trackLabel === "옷" && d.toLabel === "젖음")).toBe(true);
    // 비가 그쳐도 바깥에서는 마르지 않는다
    store.getState().weather = null;
    exposeToCold(ctx, "search", store.getState().time, store.getState().time + 6 * 60);
    store.getState().time += 6 * 60;
    expect(store.getState().wet[me().id]).toBe(wet.fire_hours * 60);
    expect(feelsLike(content, store.getState(), "search")!.parts.some((p) => p.startsWith("젖은 옷 -"))).toBe(true);
    // 지붕 아래 두 시간이면 반쯤
    store.getState().playerPlace = indoorOf("old_town");
    exposeToCold(ctx, "rest", store.getState().time, store.getState().time + 120);
    store.getState().time += 120;
    expect(store.getState().wet[me().id]).toBe(wet.fire_hours * 60 / 2);
    // 불 곁 한 시간이면 나머지가 마른다
    store.getState().fires[fireSpot(store.getState())!] = store.getState().time + 240;
    const dried = exposeToCold(ctx, "rest", store.getState().time, store.getState().time + 60);
    expect(store.getState().wet[me().id]).toBeUndefined();
    expect(dried.some((d) => d.type === "heal" && d.trackLabel === "옷")).toBe(true);
  });

  it("젖은 옷은 추운 날일수록 체감을 더 떨어뜨린다 (12-251)", () => {
    const c = content.scenario.body!.cold!.climate!;
    expect(wetDegrees(c, c.comfort - 1)).toBe(c.wet!.degrees.cold);
    expect(wetDegrees(c, c.warm - 1)).toBe(c.wet!.degrees.cool);
    expect(wetDegrees(c, c.warm + 5)).toBe(c.wet!.degrees.mild);
  });

  it("갈아입을 옷이 있는 곳에서만 갈아입어 마른다 (12-186)", () => {
    const { store, ctx, me } = setup({ quiet: true });
    store.append({ type: "wet_set", characterId: me().id, left: 120, cause: "test" });
    store.getState().playerZone = "overpass";
    const no = executeTool("take_action", { intent: "갈아입는다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, change_clothes: true }, ctx);
    expect(no.ok && no.resultText).toContain("갈아입지 못했다");
    expect(store.getState().wet[me().id]).toBe(120);
    store.getState().playerZone = "mall_ruins";
    const yes = executeTool("take_action", { intent: "갈아입는다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, change_clothes: true }, ctx);
    expect(yes.ok && yes.resultText).toContain("갈아입었다");
    expect(store.getState().wet[me().id]).toBeUndefined();
  });

  it("이야기에서 물에 빠지면 젖는다 (soak)", () => {
    const { store, ctx, me } = setup({ quiet: true });
    const base = content.storylets.wg_gunshot_wave!;
    const story = { ...base, cast: {}, choices: [{ id: "x", label: "x", effects: [{ soak: true as const }] }] };
    const c = { ...ctx, content: { ...ctx.content, storylets: { ...ctx.content.storylets, [story.id]: story } } };
    fireStorylet(c, story as never, {});
    const out = executeTool("resolve_storylet", { choice_id: "x" }, c);
    expect(out.ok && out.resultText).toContain("젖었다");
    expect(store.getState().wet[me().id]).toBeGreaterThan(0);
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
    // 단계와 쌓인 냉기를 합쳐 본다 (방한복만큼 덜 춥다)
    const chill = (id: string) => idx(id) * 100 + (after.coldLoad[id] ?? 0);
    expect(chill(dressed!)).toBeLessThan(chill(bare!));
    expect(feelsLike(content, after, "guard_duty", after.time, dressed!)!.parts.some((p) => p.includes("방한복"))).toBe(true);
  });

  it("성당·캠퍼스 같은 피난처의 실내는 거점보다는 춥지만 얼지 않는다 (12-122)", () => {
    const { store } = setup({ zone: "cathedral", hour: SEGMENT_START_HOUR.night + 1 });
    store.getState().weather = { day: dayOf(store.getState().time), id: "cold_snap" };
    const f = feelsLike(content, store.getState(), "sleep")!;
    expect(f.parts.some((p) => p.startsWith("피난처의 난로"))).toBe(true);
    expect(f.value).toBe(content.scenario.body!.cold!.climate!.sanctuary);
    // 바깥에서 보초를 서면 그대로 춥다
    store.getState().playerPlace = null;
    expect(feelsLike(content, store.getState(), "guard_duty")!.parts.some((p) => p.startsWith("피난처의 난로"))).toBe(false);
  });
});
