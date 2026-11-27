import { describe, expect, it } from "vitest";
import { fireSpot } from "../rules/place.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { dayOf, MINUTES_PER_DAY, SEGMENT_START_HOUR } from "../rules/time.ts";
import { seasonAt } from "../sim/season.ts";
import { checkNeed, needItem } from "../rules/needs.ts";
import { exposeToCold, soak } from "./climate.ts";
import { forageProblem, handleTrap } from "./forage.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 필수품 (공통 규칙 25, 12-350): 우비·우산·방수포·라이터·밧줄·덫·호루라기·정수 알약 */
const content = loadRealContent();
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
const check = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, target_harm: "none", ...extra });
const indoorOf = (zone: string) => content.locations[zone]?.places.find((p) => p.indoor && !p.jail)?.id ?? null;

/** 겨울 낮 구시가 바깥(entry)이나 실내, 빈손, 날씨 없음 */
function setup(opts: { entry?: boolean; rain?: boolean } = {}) {
  const c = { ...content, storylets: {} };
  const store = new InMemoryGameStore([createWorldEvent(c, "role_l_wanderer", "world_needs", () => 0.5)]);
  const ctx = { store, rng: () => 0.5, content: c };
  const state = store.getState();
  let day = Math.floor(state.time / MINUTES_PER_DAY);
  while (seasonAt(content.scenario, day * MINUTES_PER_DAY)?.label !== "겨울") day++;
  state.time = day * MINUTES_PER_DAY + (SEGMENT_START_HOUR.day + 1) * 60;
  state.weather = opts.rain ? { day: dayOf(state.time), id: "rain" } : null;
  state.playerZone = "old_town";
  state.playerPlace = opts.entry ? null : indoorOf("old_town");
  const me = () => store.getState().characters[store.getState().playerId]!;
  me().traits = [];
  me().inventory = {};
  me().equipped = { weapon: null, body: null, head: null, arms: null, outer: null };
  store.getState().companions = [];
  return { store, ctx, me };
}

describe("필수품 (공통 규칙 25)", () => {
  it("필수품은 보정을 주지 않고, 없으면 시나리오가 정한 만큼 불리하거나 못 한다", () => {
    const { me } = setup();
    expect(checkNeed(content, me(), "climb")).toEqual({ ok: true, item: null, parts: [{ label: "밧줄 없이 맨손", value: -2 }] });
    me().inventory.rope = 1;
    expect(checkNeed(content, me(), "climb")).toEqual({ ok: true, item: "rope", parts: [] });
    // 덫은 없으면 못 한다
    expect(checkNeed(content, me(), "trap").ok).toBe(false);
    // 필수품에는 스킬 보정이 없다
    for (const id of ["rope", "shovel", "lighter", "matchbox", "whistle", "tarp", "rat_trap", "purifier_tablets", "fishing_kit", "toolkit", "carpentry_kit"]) expect(content.items[id]!.tool).toBeUndefined();
    // 깡통 경보줄은 쳐 두고 쉴 때만 (걸어 다닐 때는 붙지 않는다)
    expect(content.items.tin_alarm!.tool?.only?.activities).toEqual(["sleep", "rest", "guard_duty", "wait"]);
  });

  it("판정에 check.needs를 붙이면 밧줄 없이 -2가 판정 줄에 보이고, 밧줄이 있으면 붙지 않는다", () => {
    const { ctx, me } = setup({ entry: true });
    const bare = executeTool("take_action", act({ intent: "담을 탄다", check: check("athletics", "strength", { needs: "climb" }) }), ctx);
    expect(bare.ok && bare.resultText).toContain("밧줄 없이 맨손");
    me().inventory.rope = 1;
    const roped = executeTool("take_action", act({ intent: "담을 탄다", check: check("athletics", "strength", { needs: "climb" }) }), ctx);
    expect(roped.ok && roped.resultText).not.toContain("밧줄 없이");
    // 판정에 붙이는 일이 아닌 것은 막는다
    const wrong = executeTool("take_action", act({ check: check("athletics", "strength", { needs: "fire" }) }), ctx);
    expect(wrong.ok).toBe(false);
  });

  it("밖에서 불을 피우려면 라이터·성냥이 있어야 하고, 쓸 때마다 닳아 다 쓰면 없어진다", () => {
    const { ctx, store, me } = setup({ entry: true });
    me().inventory.firewood = 1;
    const none = executeTool("take_action", act({ use_item: "firewood" }), ctx);
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toContain("불 붙일 것");
    expect(me().inventory.firewood).toBe(1);
    // 성냥갑은 다섯 번 쓰면 없어진다
    me().inventory.matchbox = 1;
    me().inventory.firewood = 5;
    for (let i = 0; i < 5; i++) {
      store.getState().fires = {};
      const lit = executeTool("take_action", act({ use_item: "firewood" }), ctx);
      expect(lit.ok && lit.resultText).toContain("성냥갑으로 불을 붙였다");
      if (i === 4) expect(lit.ok && lit.resultText).toContain("성냥갑을 다 썼다");
    }
    expect(me().inventory.matchbox ?? 0).toBe(0);
  });

  it("불 붙일 것 없이는 생존 판정을 걸어 한 시간 비벼 피운다. 불이 이미 타고 있으면 덧넣을 뿐이다", () => {
    const { ctx, store, me } = setup({ entry: true });
    me().inventory.firewood = 2;
    const before = store.getState().time;
    const hand = executeTool("take_action", act({ use_item: "firewood", check: check("survival", "senses") }), ctx);
    expect(hand.ok && hand.resultText).toContain("불 붙일 것 없이");
    expect(hand.ok && hand.resultText).toContain("비벼");
    expect(store.getState().time - before).toBeGreaterThanOrEqual(60);
    // 다른 스킬로는 비벼 피우지 못한다
    store.getState().fires = {};
    const wrongMove = executeTool("take_action", act({ use_item: "firewood", check: check("athletics", "strength") }), ctx);
    expect(wrongMove.ok).toBe(false);
    // 타는 불에는 붙일 것 없이 덧넣는다
    store.getState().fires[fireSpot(store.getState())!] = store.getState().time + 60;
    const add = executeTool("take_action", act({ use_item: "firewood" }), ctx);
    expect(add.ok).toBe(true);
  });

  it("비 맞는 바깥에서는 방수포 없이 비벼 피우지 못한다", () => {
    const { ctx, me } = setup({ entry: true, rain: true });
    me().inventory.firewood = 1;
    const rain = executeTool("take_action", act({ use_item: "firewood", check: check("survival", "senses") }), ctx);
    expect(!rain.ok && rain.error).toContain("비 맞는 바깥");
    me().inventory.tarp = 1;
    const tarp = executeTool("take_action", act({ use_item: "firewood", check: check("survival", "senses") }), ctx);
    expect(tarp.ok).toBe(true);
  });

  it("비닐 우비와 무기 칸에 든 우산은 비를 막고, 물일은 고무 방수복만 막는다", () => {
    for (const [slot, item] of [["outer", "raincoat"], ["weapon", "umbrella"]] as const) {
      const { ctx, store, me } = setup({ entry: true, rain: true });
      me().inventory[item] = 1;
      me().equipped[slot] = item;
      exposeToCold(ctx, "search", store.getState().time, store.getState().time + 60);
      expect(store.getState().wet[me().id]).toBeUndefined();
      soak(ctx, me().id, "물이 튀었다", true);
      expect(store.getState().wet[me().id]).toBeGreaterThan(0);
    }
    const { ctx, store, me } = setup({ entry: true, rain: true });
    me().inventory.oilskin = 1;
    me().equipped.outer = "oilskin";
    soak(ctx, me().id, "물이 튀었다", true);
    expect(store.getState().wet[me().id]).toBeUndefined();
    // 우산을 지니기만 하고 들지 않으면 젖는다
    const held = setup({ entry: true, rain: true });
    held.me().inventory.umbrella = 1;
    exposeToCold(held.ctx, "search", held.store.getState().time, held.store.getState().time + 60);
    expect(held.store.getState().wet[held.me().id]).toBeGreaterThan(0);
  });

  it("방수포를 지니고 바깥에서 쉬면 젖지 않고 지붕 아래처럼 마른다. 돌아다니면 젖는다", () => {
    const { ctx, store, me } = setup({ entry: true, rain: true });
    me().inventory.tarp = 1;
    exposeToCold(ctx, "rest", store.getState().time, store.getState().time + 60);
    expect(store.getState().wet[me().id]).toBeUndefined();
    exposeToCold(ctx, "search", store.getState().time, store.getState().time + 60);
    const wet = store.getState().wet[me().id]!;
    expect(wet).toBeGreaterThan(0);
    store.getState().weather = null;
    exposeToCold(ctx, "rest", store.getState().time, store.getState().time + 60);
    expect(store.getState().wet[me().id] ?? 0).toBeLessThan(wet);
  });

  it("낚시는 낚시 도구가 있어야 한다", () => {
    const { ctx, store, me } = setup({ entry: true });
    const water = Object.keys(content.locations).find((z) => content.locations[z]!.kind !== "base" && (content.locations[z]!.yields.water ?? 0) > 0)!;
    store.getState().playerZone = water;
    store.getState().playerPlace = null;
    me().skills.fishing = 1;
    expect(forageProblem(ctx, "fish")).toContain("낚시 도구");
    me().inventory.fishing_kit = 1;
    expect(forageProblem(ctx, "fish")).toBeNull();
  });

  it("쥐덫도 철사 뭉치처럼 덫으로 놓고, 거두면 놓은 덫이 돌아온다", () => {
    const { ctx, store, me } = setup({ entry: true });
    me().inventory.rat_trap = 1;
    const set = handleTrap(ctx, "set", "success");
    expect(set.ok).toBe(true);
    expect(store.getState().traps[0]?.item).toBe("rat_trap");
    expect(me().inventory.rat_trap ?? 0).toBe(0);
    const got = handleTrap(ctx, "check");
    expect(got.ok && got.lines[0]).toContain("쥐덫");
    expect(me().inventory.rat_trap).toBe(1);
    // 덫 물건이 없으면 놓지 못한다
    me().inventory = {};
    expect(handleTrap(ctx, "set", "success").ok).toBe(false);
  });

  it("호루라기로 꾀어내면 구역에 소음 1, 없으면 소리쳐 소음 2", () => {
    const a = setup({ entry: true });
    a.me().inventory.whistle = 1;
    const blown = executeTool("take_action", act({ intent: "호루라기를 분다", lure: true }), a.ctx);
    expect(blown.ok && blown.resultText).toContain("호루라기를 불어");
    expect(a.store.getState().zoneNoise.old_town?.level).toBe(1);
    const b = setup({ entry: true });
    const shout = executeTool("take_action", act({ intent: "소리친다", lure: true }), b.ctx);
    expect(shout.ok && shout.resultText).toContain("소리쳐");
    expect(b.store.getState().zoneNoise.old_town?.level).toBe(2);
  });

  it("불이 없을 때 끓이지 않은 물은 정수 알약 하나를 넣어 마신다", () => {
    const { ctx, me } = setup({ entry: true });
    me().inventory.dirty_water = 1;
    me().inventory.purifier_tablets = 2;
    const thirst = content.scenario.condition_tracks.find((t) => t.id === "thirst")!;
    me().conditions.thirst = thirst.levels[2]!.id;
    const out = executeTool("take_action", act({ use_item: "dirty_water" }), ctx);
    expect(out.ok && out.resultText).toContain("걸러 마셨다");
    expect(me().inventory.purifier_tablets).toBe(1);
    expect(needItem(content, me(), "purify")).toBe("purifier_tablets");
  });
});
