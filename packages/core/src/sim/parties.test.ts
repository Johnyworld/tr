import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { WorldManager } from "../world/manager.ts";
import { advanceParties, arrivalOf, canSend, detourRoute, hidingAt, spawnIntercept, maxParties, partiesConfig, partyRoute, partyZoneAt, recordDefeat, returnOf, spawnParty } from "./parties.ts";
import { runGarrisonWatch, settlePartyAlerts, warConfessions } from "../engine/partyTools.ts";
import { executeTool } from "../engine/tools.ts";
import { factionOutlook } from "../engine/warTools.ts";
import { describePlayerState } from "../engine/context.ts";
import { frontBusy } from "../engine/missionTools.ts";
import { warCauses } from "../engine/warAftermath.ts";
import { fearSourcePresent } from "../engine/fear.ts";
import { baseOfNow } from "../rules/home.ts";
import { pickDailyOffers, warMission } from "../game/missions.ts";
import { placesIn, whereIs } from "../rules/place.ts";
import { endBattle, forceWords } from "../engine/battleTools.ts";
import { applyEffect } from "../engine/storyletTools.ts";
import { clashForces, initialWarWorld, simulateWarDay, spawnWatchParties, type WarWorld } from "./war.ts";
import type { Party } from "../game/state.ts";
import { alertablePartiesLines, createPartyCheck, PARTY_INTERRUPT, partyPlacePath, rollPartySight, seenPartiesLines, settleSighting, sightKey } from "../engine/partySight.ts";

const content = loadRealContent();
const cfg = partiesConfig(content)!;
const fresh = (): WarWorld => initialWarWorld(content);
const hour = (t: number) => Math.floor((((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60);

describe("움직이는 부대 (docs/war-parties-plan.md ①)", () => {
  it("동시 부대 수는 전투원 수로, 내보낸 뒤에도 지키는 병력이 남아야 한다 (1-1)", () => {
    expect(maxParties(cfg, 80)).toBe(3);
    expect(maxParties(cfg, 25)).toBe(2);
    expect(maxParties(cfg, 6)).toBe(1);
    const w = fresh();
    // 하얀매(전투원 6): 지키는 병력 20%(2명)를 남겨야 하니 다섯은 못 낸다
    expect(canSend(w, cfg, "faction_d", 5)).toBe(false);
    expect(canSend(w, cfg, "faction_d", 3)).toBe(true);
  });

  it("길은 적대하는 땅을 돌아간다 (3-3)", () => {
    const w = fresh();
    const direct = partyRoute(content, w, "faction_a", "a_base", "old_town")!;
    expect(direct[0]).toBe("a_base");
    expect(direct.at(-1)).toBe("old_town");
    // 버스 차고지를 붉은연합이 쥐면 고가도로로 돌아간다
    w.zones.bus_depot = { owner: "faction_c" };
    expect(partyRoute(content, w, "faction_a", "a_base", "old_town")).toEqual(["a_base", "overpass", "old_town"]);
  });

  it("부대를 내면 전투원에서 빠지고, 길은 끊김 없이 이어지며, 정찰은 지나는 구역마다 머문다 (3-0)", () => {
    const w = fresh();
    const before = w.factions.faction_c!.combatants;
    const p = spawnParty(w, content, createSeededRng(1), { faction: "faction_c", kind: "scout", goal: "a_east_post", size: 3, dayStart: 0, task: { kind: "watch" } })!;
    expect(p).toBeTruthy();
    expect(w.factions.faction_c!.combatants).toBe(before - 3);
    for (let i = 1; i < p.legs.length; i++) expect(p.legs[i]!.from).toBe(p.legs[i - 1]!.to);
    // 목표 앞의 구역들에서 4~6시간 머문다 (이동 시간 더하기)
    for (const leg of p.legs.slice(1, -1)) expect(leg.to - leg.from).toBeGreaterThanOrEqual(4 * 60);
    expect(partyZoneAt(p, p.legs[1]!.from + 1)).toBe(p.legs[1]!.zone);
  });

  it("습격대는 목표 바로 앞에서 숨었다가 밤에 치고, 공세 부대는 거점에서 하루 모인다", () => {
    const w = fresh();
    const raid = spawnParty(w, content, createSeededRng(2), { faction: "faction_c", kind: "raid", goal: "a_east_post", size: 8, dayStart: 0, task: { kind: "clash", clash: "raid", defender: "faction_a" } })!;
    const strike = cfg.kinds.raid!.strike!;
    expect(hour(raid.legs.at(-2)!.to)).toBeGreaterThanOrEqual(strike[0]);
    expect(hour(raid.legs.at(-2)!.to)).toBeLessThanOrEqual(strike[1]);
    const w2 = fresh();
    const assault = spawnParty(w2, content, createSeededRng(3), { faction: "faction_c", kind: "assault", goal: "a_east_post", size: 20, dayStart: 0, task: { kind: "clash", clash: "assault", defender: "faction_a" } })!;
    expect(assault.legs[0]!.to - assault.legs[0]!.from).toBe(cfg.kinds.assault!.gather_hours * 60);
  });

  it("닿으면 간 인원으로 싸우고, 남은 사람은 돌아와 전투원이 된다", () => {
    const w = fresh();
    const rng = createSeededRng(4);
    const total = w.factions.faction_c!.combatants;
    const p = spawnParty(w, content, rng, { faction: "faction_c", kind: "raid", goal: "a_east_post", size: 8, dayStart: 0, task: { kind: "clash", clash: "raid", defender: "faction_a" } })!;
    expect(advanceParties(w, content, rng, arrivalOf(p) - 1).clashes).toEqual([]);
    const { clashes } = advanceParties(w, content, rng, arrivalOf(p));
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post" });
    const back = w.parties!.find((x) => x.id === p.id);
    const lost = clashes[0]!.attackerLosses;
    if (back) {
      expect(back.done).toBe(true);
      advanceParties(w, content, rng, returnOf(back)!);
    }
    expect(w.parties!.some((x) => x.id === p.id)).toBe(false);
    expect(w.factions.faction_c!.combatants).toBe(total - lost);
  });

  it("땅 차지는 순찰대가 닿아야 이뤄진다 (2-2)", () => {
    const w = fresh();
    const rng = createSeededRng(5);
    const p = spawnParty(w, content, rng, { faction: "faction_c", kind: "patrol", goal: "rail_embankment", size: 4, dayStart: 0, task: { kind: "occupy" } })!;
    advanceParties(w, content, rng, arrivalOf(p) - 1);
    expect(w.zones.rail_embankment!.owner).toBeNull();
    const { clashes } = advanceParties(w, content, rng, arrivalOf(p));
    expect(clashes[0]).toMatchObject({ kind: "occupy", attacker: "faction_c", zone: "rail_embankment" });
    expect(w.zones.rail_embankment!.owner).toBe("faction_c");
  });

  it("짐 행렬은 실어 간 것을 상대 창고에 넣고, 바꾼 것을 싣고 돌아온다 (2-3)", () => {
    const w = fresh();
    const rng = createSeededRng(6);
    const give = { food: 30 };
    const get = { ammo: 15 };
    const a0 = { ...w.factions.faction_a!.resources };
    const e0 = { ...w.factions.faction_e!.resources };
    const p = spawnParty(w, content, rng, { faction: "faction_a", kind: "supply", goal: "e_market", size: 3, dayStart: 0, carry: give, task: { kind: "trade", partner: "faction_e", give, get } })!;
    expect(w.factions.faction_a!.resources.food).toBe(a0.food! - 30);
    advanceParties(w, content, rng, arrivalOf(p));
    expect(w.factions.faction_e!.resources.food).toBe(e0.food! + 30);
    expect(w.factions.faction_e!.resources.ammo).toBe(e0.ammo! - 15);
    const back = w.parties!.find((x) => x.id === p.id)!;
    expect(back.carry).toEqual(get);
    advanceParties(w, content, rng, returnOf(back)!);
    expect(w.factions.faction_a!.resources.ammo).toBe(a0.ammo! + 15);
  });

  it("플레이어가 낄 교전은 닿는 시각으로 미루고(실제로 온 인원과 함께, PT37), 부대는 흩어져 전투원으로 돌아간다", () => {
    const w = fresh();
    const rng = createSeededRng(7);
    const total = w.factions.faction_c!.combatants;
    const p = spawnParty(w, content, rng, { faction: "faction_c", kind: "raid", goal: "a_east_post", size: 8, dayStart: 0, task: { kind: "clash", clash: "raid", defender: "faction_a" } })!;
    const r = advanceParties(w, content, rng, arrivalOf(p), { defer: () => true });
    expect(r.clashes).toEqual([]);
    expect(r.deferred).toEqual([{ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", at: arrivalOf(p), force: 8 }]);
    expect(w.parties).toEqual([]);
    expect(w.factions.faction_c!.combatants).toBe(total);
  });

  it("총공격 하루 전에 정찰대가 목표로 나간다 (2-1)", () => {
    let w = fresh();
    const rng = createSeededRng(8);
    const clock = w.clocks.c_east_offensive!;
    clock.filled = clock.max - 2;
    const r = simulateWarDay(w, content, rng, { day: 1 });
    w = { ...r };
    const scouts = (w.parties ?? []).filter((p) => p.kind === "scout" && p.faction === "faction_c");
    expect(scouts.map((s) => s.goal)).toContain(clock.target);
  });

  it("세계에서 날이 바뀌면 부대가 세이브에 남는다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-parties-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
    for (let i = 0; i < 6; i++) w.runCheat("~time +24h");
    expect(w.state().nextPartyNo).toBeGreaterThan(0);
    for (const p of w.state().parties) expect(content.factions[p.faction]).toBeTruthy();
    w.close();
  });
});

/** 정해 둔 값을 차례로 내놓고, 다 쓰면 0.5 */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => (i < xs.length ? xs[i++]! : 0.5);
};
const party = (over: Partial<Party> & Pick<Party, "id" | "faction" | "kind" | "size" | "goal" | "legs" | "task">): Party => ({
  leader: null,
  home: over.faction === "faction_a" ? "a_base" : "c_base",
  done: false,
  back: [],
  carry: {},
  met: [],
  routedAt: null,
  ...over,
});

describe("마주침 (공통 규칙 23, ②)", () => {
  it("부대끼리 같은 구역에 들면 알아채고, 자기 땅의 순찰은 덤비고, 진 정찰대는 달아나며 공세가 하루 늦어진다", () => {
    const w = fresh();
    const clock = w.clocks.c_east_offensive!;
    clock.filled = clock.max - 1;
    const t = 10 * 60;
    w.parties = [
      party({ id: "pa", faction: "faction_a", kind: "patrol", size: 6, goal: "a_east_post", legs: [{ zone: "a_base", from: t - 60, to: t - 60 }, { zone: "a_east_post", from: t - 60, to: t + 120 }], task: { kind: "watch" } }),
      party({ id: "pc", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", legs: [{ zone: "rail_embankment", from: t - 120, to: t }, { zone: "a_east_post", from: t, to: t + 60 }], task: { kind: "watch", plan: "c_east_offensive" } }),
    ];
    // 두 쪽 다 12를 굴려 본다, 순찰이 이긴다
    const r = advanceParties(w, content, seq(0.99, 0.99, 0.99, 0.99, 0.01), t + 1);
    expect(r.clashes[0]).toMatchObject({ kind: "skirmish", attacker: "faction_a", defender: "faction_c", zone: "a_east_post", success: true });
    const scout = w.parties!.find((p) => p.id === "pc")!;
    expect(scout.done).toBe(true);
    expect(scout.back.at(-1)?.zone).toBe("c_base");
    expect(clock.filled).toBe(clock.max - 2);
    // 본 쪽 무리는 하루 동안 상대 무리의 빈틈을 안다 (7-2)
    expect(w.factions.faction_a!.seen?.faction_c).toBe(t + MINUTES_PER_DAY);
  });

  it("둘 다 못 보면 스쳐 지나가고, 한 짝은 한 번만 마주친다", () => {
    const w = fresh();
    const t = 22 * 60;
    w.parties = [
      party({ id: "pa", faction: "faction_a", kind: "patrol", size: 6, goal: "a_east_post", legs: [{ zone: "a_base", from: t - 60, to: t - 60 }, { zone: "a_east_post", from: t - 60, to: t + 120 }], task: { kind: "watch" } }),
      party({ id: "pc", faction: "faction_c", kind: "raid", size: 8, goal: "a_east_post", legs: [{ zone: "rail_embankment", from: t - 120, to: t }, { zone: "a_east_post", from: t, to: t + 60 }], task: { kind: "watch" } }),
    ];
    const r = advanceParties(w, content, seq(0, 0, 0, 0), t + 30);
    expect(r.clashes).toEqual([]);
    expect(w.parties!.find((p) => p.id === "pa")!.met).toEqual(["pc"]);
  });

  it("같은 날 두 번 지면 남은 사람이 붙잡힌다 (4-4)", () => {
    const w = fresh();
    const t = 10 * 60;
    w.parties = [
      party({ id: "pa", faction: "faction_a", kind: "patrol", size: 9, goal: "a_east_post", legs: [{ zone: "a_base", from: t - 60, to: t - 60 }, { zone: "a_east_post", from: t - 60, to: t + 120 }], task: { kind: "watch" } }),
      party({ id: "pc", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", routedAt: t - 120, legs: [{ zone: "rail_embankment", from: t - 120, to: t }, { zone: "a_east_post", from: t, to: t + 60 }], task: { kind: "watch" } }),
    ];
    const pop = w.factions.faction_c!.population;
    advanceParties(w, content, seq(0.99, 0.99, 0.99, 0.99, 0.01, 0), t + 1);
    expect(w.parties!.find((p) => p.id === "pc")?.size ?? 0).toBe(0);
    expect(w.factions.faction_c!.population).toBe(pop - 3);
  });
});

describe("주인공과 부대 (공통 규칙 23, 9-1·9-2)", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sight-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
  const raider = (zone: string, from: number) =>
    party({ id: "pr", faction: "faction_c", kind: "raid", size: 8, goal: zone, legs: [{ zone: "c_base", from: from - 600, to: from - 600 }, { zone, from, to: from + 120 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } });

  it("바깥에 있으면 적대하는 부대를 보고 빨리감기가 멈춘다. 지켜 주는 거점에서는 멈추지 않는다", () => {
    const w = make();
    const base = w.state();
    // 우리 거점: 굴리지 않는다
    const atBase = { ...base, parties: [raider("a_base", base.time + 30)] };
    expect(createPartyCheck(content, "wait")({ state: atBase, from: base.time, to: base.time + 60, rng: () => 0.99 })).toBeNull();
    // 동쪽 초소의 망루(바깥): 12를 굴려 본다
    const post = { ...base, playerZone: "a_east_post", playerPlace: "watchtower", parties: [raider("a_east_post", base.time + 30)] };
    const hit = createPartyCheck(content, "wait")({ state: post, from: base.time, to: base.time + 60, rng: () => 0.99 });
    expect(hit).toMatchObject({ kind: "disturbance", at: base.time + 30 });
    expect(hit!.detail.startsWith(`${PARTY_INTERRUPT}:pr:1`)).toBe(true);
    // 초소 안(실내): 보지 못한다
    const inside = { ...post, playerPlace: "bunker" };
    expect(createPartyCheck(content, "wait")({ state: inside, from: base.time, to: base.time + 60, rng: () => 0.99 })).toBeNull();
    // 혼자 잠들었으면 주인공은 보지 못한다 (부대가 덤비지 않으면 멈추지 않는다)
    expect(rollPartySight(post, content, () => 0.99, post.parties[0]!, base.time + 30, { asleep: true, watched: false }).player).toBe(false);
    w.close();
  });

  it("본 부대는 GM 상태에 대략으로만 (원칙 4)", () => {
    const w = make();
    const s = w.state();
    const p = raider("a_east_post", s.time - 10);
    const state = { ...s, playerZone: "a_east_post", playerPlace: "watchtower", parties: [p], partySightings: { [sightKey(p, "a_east_post", s.time)]: { at: s.time, player: true, party: false } } };
    const lines = seenPartiesLines(state, content);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("예닐곱 명");
    expect(lines[0]).not.toContain("습격");
    expect(seenPartiesLines({ ...state, partySightings: {} }, content)).toEqual([]);
    w.close();
  });
});

describe("③-1 닿을 때 계산·장소 거리·믿음", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-lazy-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", "role_a_grunt");
  const put = (w: ReturnType<typeof make>, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };
  const raidFromEmbankment = (t: number) =>
    party({ id: "pr", faction: "faction_c", kind: "raid", size: 8, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 600, to: t - 300 }, { zone: "rail_embankment", from: t - 300, to: t }, { zone: "a_east_post", from: t, to: t + 60 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } });

  it("부대는 닿은 뒤에야 싸운다: 시간이 흘러 닿는 시각을 넘기면 그때 교전이 일어난다", () => {
    const w = make();
    const t = w.state().time + 180;
    put(w, [raidFromEmbankment(t + 60)]);
    expect(w.state().parties[0]!.done).toBe(false);
    w.runCheat("~time +5h");
    const s = w.state();
    expect(s.recentClashes.some((r) => r.party && r.clash.kind === "raid" && r.clash.zone === "a_east_post")).toBe(true);
    expect(s.parties.find((p) => p.id === "pr")?.done ?? true).toBe(true);
    w.close();
  });

  it("장소 사이는 멀다: 두 칸 떨어지면 못 보고, 한 칸 옆이나 망루(두 칸)에서는 본다 (파트 12)", () => {
    const w = make();
    const t = w.state().time + 30;
    const p = raidFromEmbankment(t + 60);
    const at = (place: string) => ({ ...w.state(), playerZone: "a_east_post", playerPlace: place, parties: [p] });
    // 들어오는 길은 철길 둑 쪽 비탈
    expect(partyPlacePath(at("trench"), content, p, "a_east_post", t + 60).enter).toBe("to_warehouse");
    const sure = () => 0.99;
    expect(rollPartySight(at("to_base"), content, sure, p, t + 60).player).toBe(false);
    expect(rollPartySight(at("trench"), content, sure, p, t + 60).player).toBe(true);
    expect(rollPartySight(at("watchtower"), content, sure, p, t + 60).player).toBe(true);
    w.close();
  });

  it("본 부대는 믿음으로 남는다: 언제·어디서·대략 몇 명·어느 길로, 목적은 없이 (8-1)", () => {
    const w = make();
    const t = w.state().time;
    const p = raidFromEmbankment(t);
    put(w, [p]);
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    const before = (w.state().beliefs[w.state().playerId] ?? []).length;
    settleSighting(w.ctx(), w.state().parties[0]!, { player: true, party: false, attacks: false }, w.state().time);
    const beliefs = w.state().beliefs[w.state().playerId] ?? [];
    expect(beliefs.length).toBe(before + 1);
    const b = beliefs.at(-1)!;
    expect(b).toMatchObject({ source: "seen", topic: "war" });
    expect(b.fact).toContain("동쪽 초소");
    expect(b.fact).toContain("예닐곱 명");
    expect(b.fact).toContain("철길 둑 가는 비탈");
    expect(b.fact).not.toContain("습격");
    w.close();
  });
});

describe("③-2 부대와 맞붙기·우두머리·지렛대", () => {
  const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-engage-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", role);
  type W = ReturnType<typeof make>;
  const put = (w: W, parties: Party[], world?: Partial<WarWorld>) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: world?.factions ?? s.factions, zones: world?.zones ?? s.zones, clocks: Object.fromEntries(Object.entries(world?.clocks ?? s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };
  const atPost = (w: W) => w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
  const raiders = (w: W, size: number, leader: string | null = null) => {
    const t = w.state().time;
    return party({ id: "pr", faction: "faction_c", kind: "raid", size, leader, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 600, to: t - 300 }, { zone: "rail_embankment", from: t - 300, to: t - 10 }, { zone: "a_east_post", from: t - 10, to: t + 120 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } });
  };
  const seen = (w: W) => w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties.find((x) => x.id === "pr")!, "a_east_post", w.state().time), player: true, party: false });
  const harm = (w: W, id: string, to: string) => {
    const c = w.state().characters[id]!;
    w.ctx().store.append({ type: "condition_changed", targetId: id, track: content.scenario.harm_track, from: c.conditions[content.scenario.harm_track] ?? "none", to, fatal: false, by: w.state().playerId, cause: "test", day: 1, harmTrack: true });
  };

  it("작은 무리와 맞붙으면 부대원이 엑스트라로 들어오고, 절반이 쓰러지면 무리가 달아난다", () => {
    const w = make();
    atPost(w);
    put(w, [raiders(w, 4)]);
    seen(w);
    expect(w.executeTool("engage_party", { party_id: "nope" }).ok).toBe(false);
    const r = w.executeTool("engage_party", { party_id: "pr" });
    expect(r.ok).toBe(true);
    const members = w.state().partyFights.pr!.members;
    expect(members).toHaveLength(4);
    for (const id of members) expect(w.state().scene.present).toContain(id);
    harm(w, members[0]!, "serious");
    harm(w, members[1]!, "serious");
    w.runCheat("~time +1h");
    const p = w.state().parties.find((x) => x.id === "pr")!;
    expect(w.state().partyFights.pr).toBeUndefined();
    expect(p.size).toBe(2);
    expect(p.done).toBe(true);
    expect(p.back.at(-1)?.zone).toBe("c_base");
    // 쓰러진 사람은 남고, 남은 사람은 떠났다
    expect(w.state().scene.present).toContain(members[0]);
    expect(w.state().scene.present).not.toContain(members[2]);
    w.close();
  });

  it("우두머리가 쓰러지면 무리가 달아나고 그 무리의 공격 계획이 절반으로 물러난다 (6-1)", () => {
    const w = make();
    atPost(w);
    const leader = Object.values(content.npcs).find((n) => n.faction === "faction_c" && cfg.leader_ranks.includes(n.rank))!.id;
    const s = w.state();
    const clocks = structuredClone(s.clocks);
    clocks.c_east_offensive!.filled = 8;
    put(w, [raiders(w, 5, leader)], { clocks });
    seen(w);
    // 이끄는 사람은 부대가 있는 구역에 있다 (1-3)
    expect(w.executeTool("engage_party", { party_id: "pr" }).ok).toBe(true);
    expect(w.state().partyFights.pr!.members).toContain(leader);
    harm(w, leader, "serious");
    w.runCheat("~time +1h");
    expect(w.state().clocks.c_east_offensive!.filled).toBe(4);
    expect(w.state().parties.find((x) => x.id === "pr")!.done).toBe(true);
    w.close();
  });

  it("큰 무리와 무리에 속한 주인공은 전투 장면이 열리고, 결과는 그 부대에 간다", () => {
    const w = make();
    atPost(w);
    put(w, [raiders(w, 10)]);
    seen(w);
    const combatants = w.state().factions.faction_c!.combatants;
    expect(w.executeTool("engage_party", { party_id: "pr" }).ok).toBe(true);
    expect(w.state().battle?.party).toBe("pr");
    expect(w.state().battle?.theirs.committed).toBe(10);
    endBattle(w.ctx(), true);
    expect(w.state().battle).toBeNull();
    const p = w.state().parties.find((x) => x.id === "pr")!;
    expect(p.size).toBeLessThanOrEqual(10);
    // 부대 쪽 사상자는 무리 전투원이 아니라 부대에서 빠진다
    expect(w.state().factions.faction_c!.combatants).toBe(combatants);
    w.close();
  });

  it("습격·공세 부대는 이름 있는 인물이 이끌고, 그 사람은 부대가 있는 구역에 있다 (1-3)", () => {
    const w = fresh();
    const p = spawnParty(w, content, createSeededRng(2), { faction: "faction_c", kind: "raid", goal: "a_east_post", size: 8, dayStart: 0, task: { kind: "clash", clash: "raid", defender: "faction_a" } })!;
    expect(p.leader).toBeTruthy();
    expect(cfg.leader_ranks).toContain(content.npcs[p.leader!]!.rank);
    const scout = spawnParty(w, content, createSeededRng(2), { faction: "faction_c", kind: "scout", goal: "a_east_post", size: 3, dayStart: 0, task: { kind: "watch" } })!;
    expect(scout.leader).toBeNull();
  });

  it("포로는 그 무리의 다음 공세 목표를 털어놓고, 대가 있는 성공이면 반은 틀린 말이다 (6-2)", () => {
    const w = make();
    const prisoner = Object.values(content.npcs).find((n) => n.faction === "faction_c" && n.rank === "grunt")!.id;
    const truth = warConfessions(w.state(), content, () => 0.99, prisoner, "success");
    // 나가 있는 부대가 있으면 그 이야기가 먼저다: 공세 목표는 그 뒤에
    const offensive = truth.find((t) => t.fact.includes(content.locations[w.state().clocks.c_east_offensive!.target]!.name));
    expect(offensive).toBeTruthy();
    expect(offensive!.accuracy).toBe("approximate");
    const lie = warConfessions(w.state(), content, () => 0, prisoner, "partial");
    expect(lie[0]!.accuracy).toBe("false");
    w.close();
  });

  it("사흘 안에 두 번 진 무리는 사기가 떨어진다 (6-3)", () => {
    const w = fresh();
    const m = w.factions.faction_c!.morale;
    recordDefeat(w, "faction_c", 100);
    expect(w.factions.faction_c!.morale).toBe(m);
    recordDefeat(w, "faction_c", 100 + 2 * MINUTES_PER_DAY);
    expect(w.factions.faction_c!.morale).toBe(Math.max(-3, m - 1));
  });

  it("공세 정찰대가 방비를 보고 돌아오면 frontier 클락의 목표를 바꾼다 (6-4)", () => {
    const w = fresh();
    const rng = createSeededRng(4);
    // 청솔의 반격(frontier) 정찰대가 물류창고로
    w.zones.c_warehouse = { owner: "faction_c", fort: 1 };
    const p = spawnParty(w, content, rng, { faction: "faction_a", kind: "scout", goal: "c_warehouse", size: 3, dayStart: 0, task: { kind: "watch", plan: "a_counteroffensive" } })!;
    advanceParties(w, content, rng, arrivalOf(p));
    const back = w.parties!.find((x) => x.id === p.id)!;
    advanceParties(w, content, rng, returnOf(back)!);
    expect(w.clocks.a_counteroffensive!.target).not.toBe("");
    expect(w.clocks.a_counteroffensive!.target).not.toBe("c_warehouse");
  });
});

describe("PT31 뒤 고친 것", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt31-")), content, rngFactory: () => createSeededRng(11) }).create("mcp", "role_a_grunt");
  type W = ReturnType<typeof make>;
  const put = (w: W, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };
  const at = (w: W, place: string) => w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place });
  const band = (faction: string, size: number, t: number) =>
    party({ id: "pp", faction, kind: "patrol", size, goal: "a_east_post", legs: [{ zone: "rail_embankment", from: t - 300, to: t - 10 }, { zone: "a_east_post", from: t - 10, to: t + 240 }], task: { kind: "watch" } });

  it("실내에서 굴리지 않은 마주침은 기록하지 않고, 밖으로 나오면 그때 굴린다", () => {
    const w = make();
    at(w, "bunker");
    put(w, [band("faction_c", 4, w.state().time)]);
    w.runCheat("~time +1h");
    expect(Object.keys(w.state().partySightings).some((k) => k.startsWith("pp@a_east_post"))).toBe(false);
    w.ctx().store.append({ type: "place_moved", from: "bunker", to: "trench" });
    w.runCheat("~time +1h");
    expect(Object.keys(w.state().partySightings).some((k) => k.startsWith("pp@a_east_post"))).toBe(true);
    w.close();
  });

  it("우리 무리 부대는 믿음으로 남기지 않고 engage_party로 덤빌 수 없다", () => {
    const w = make();
    at(w, "trench");
    put(w, [band("faction_a", 4, w.state().time)]);
    const before = (w.state().beliefs[w.state().playerId] ?? []).length;
    settleSighting(w.ctx(), w.state().parties[0]!, { player: true, party: false, attacks: false, rolled: true }, w.state().time);
    expect((w.state().beliefs[w.state().playerId] ?? []).length).toBe(before);
    expect(w.executeTool("engage_party", { party_id: "pp" }).ok).toBe(false);
    w.close();
  });

  it("규모 말은 4명과 7명을 가른다", () => {
    expect(forceWords(4)).toBe("네댓 명");
    expect(forceWords(7)).toBe("예닐곱 명");
    expect(forceWords(3)).toBe("몇 명");
  });

  it("이야기의 light_fire는 땔감을 써서 불을 실제로 피운다", () => {
    const w = make();
    w.ctx().store.append({ type: "item_granted", to: w.state().playerId, itemId: "firewood", quantity: 1 });
    applyEffect(w.ctx(), { light_fire: { item: "firewood" } } as never, {}, {}, "테스트");
    expect(Object.values(w.state().fires).some((until) => until > w.state().time)).toBe(true);
    w.close();
  });
});

describe("PT32 뒤 고친 것", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt32-")), content, rngFactory: () => createSeededRng(13) }).create("mcp", "role_a_grunt");
  type W = ReturnType<typeof make>;
  const put = (w: W, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };

  it("칸 경계(막 들어선 그 분)에는 들어선 구역에 있다", () => {
    const p = party({ id: "x", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", legs: [{ zone: "rail_embankment", from: 0, to: 100 }, { zone: "a_east_post", from: 100, to: 200 }], task: { kind: "watch" } });
    expect(partyZoneAt(p, 100)).toBe("a_east_post");
    expect(partyZoneAt(p, 99)).toBe("rail_embankment");
  });

  it("떠난 구역의 마주침은 잊고, 돌아오는 길의 첫 칸이 목표와 같아도 앞뒤 구역으로 자리를 잡는다", () => {
    const w = make();
    const t = w.state().time;
    // 목표(동쪽 초소)에서 머문 뒤 같은 구역에서 돌아오기 시작한 정찰대
    const p = party({ id: "pv", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", done: true, legs: [{ zone: "rail_embankment", from: t - 300, to: t - 100 }, { zone: "a_east_post", from: t - 100, to: t - 50 }], back: [{ zone: "a_east_post", from: t - 50, to: t + 100 }, { zone: "rail_embankment", from: t + 100, to: t + 200 }], task: { kind: "watch" } });
    put(w, [p]);
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    expect(partyPlacePath(w.state(), content, p, "a_east_post", t).enter).toBe("to_warehouse");
    w.ctx().store.append({ type: "party_sighted", key: sightKey(p, "a_east_post", t), player: true, party: false });
    expect(seenPartiesLines(w.state(), content)).toHaveLength(1);
    w.ctx().store.append({ type: "zone_moved", from: "a_east_post", to: "a_base", place: "yard_gate" });
    expect(Object.keys(w.state().partySightings)).toEqual([]);
    w.close();
  });

  it("부대가 덤벼 오면 맞붙음이 열리고, 서로 봤으면 매복당함이 붙지 않으며, 들킨 매복은 깨진다", () => {
    const w = make();
    const t = w.state().time;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    w.ctx().store.append({ type: "ambush_changed", ambush: { zone: "a_east_post", until: t + 600, bonus: 2, confuse: true } });
    const p = party({ id: "pa", faction: "faction_c", kind: "raid", size: 5, goal: "a_east_post", legs: [{ zone: "rail_embankment", from: t - 300, to: t - 10 }, { zone: "a_east_post", from: t - 10, to: t + 120 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } });
    put(w, [p]);
    settleSighting(w.ctx(), w.state().parties[0]!, { player: true, party: true, attacks: true, rolled: true }, t);
    expect(w.state().ambush).toBeNull();
    expect(w.state().ambushed).toBeNull();
    expect(w.state().partyFights.pa?.members.length).toBeGreaterThan(0);
    w.close();
  });

  it("정찰은 몇 칸 안의 적대하는 무리 땅으로 간다", () => {
    const w = fresh();
    spawnWatchParties(w, content, () => 0, 2, ["faction_a", "faction_c"]);
    const scouts = (w.parties ?? []).filter((p) => p.kind === "scout");
    expect(scouts.find((p) => p.faction === "faction_a")?.goal).toBe("c_warehouse");
    expect(scouts.find((p) => p.faction === "faction_c")?.goal).toBe("a_east_post");
  });

  it("세계가 열린 첫날에도 정찰·순찰이 나간다", () => {
    let any = false;
    for (let seed = 1; seed <= 5 && !any; seed++) {
      const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-day1-")), content, rngFactory: () => createSeededRng(seed) }).create("mcp", "role_a_grunt");
      any = w.state().nextPartyNo > 0;
      w.close();
    }
    expect(any).toBe(true);
  });

  it("그 자리에 있는 동안 주인이 바뀌면 본 대로 안다", () => {
    const w = make();
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "red_bridge", place: null });
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: { ...s.zones, red_bridge: { owner: "faction_c" } }, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: [], partiesUpTo: s.time, clashes: [], scheduled: [] });
    expect(w.state().zoneSeen.red_bridge).toBe("faction_c");
    w.close();
  });
});

describe("PT32 정할 것: 달아나기 실패·전선이 바쁜 날", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-chase-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", "role_a_grunt");
  type W = ReturnType<typeof make>;
  const engaged = (w: W) => {
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    const s = w.state();
    const t = s.time;
    const p = party({ id: "pr", faction: "faction_c", kind: "scout", size: 4, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 600, to: t - 300 }, { zone: "rail_embankment", from: t - 300, to: t - 10 }, { zone: "a_east_post", from: t - 10, to: t + 240 }], task: { kind: "watch" } });
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: [p], partiesUpTo: t, clashes: [], scheduled: [] });
    w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties[0]!, "a_east_post", t), player: true, party: false });
    expect(w.executeTool("engage_party", { party_id: "pr" }).ok).toBe(true);
    return w.state().partyFights.pr!.members;
  };
  const flee = (w: W, roll: number, where: { move_to?: string; place_to?: string }) =>
    executeTool("take_action", { intent: "달아난다", check: { move: "athletics", stat: "agility", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, ...where }, { ...w.ctx(), rng: () => roll });

  it("옆 구역으로 달아나다 빗나가면 맞붙은 부대원이 쫓아와 맞붙음이 그 구역에서 이어진다", () => {
    const w = make();
    const members = engaged(w);
    const r = flee(w, 0.01, { move_to: "rail_embankment" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().playerZone).toBe("rail_embankment");
    expect(r.ok && r.resultText).toContain("쫓아왔다");
    expect(r.ok && r.resultText).not.toContain("오는 길에 일이 생겼다");
    for (const id of members) expect(w.state().scene.present).toContain(id);
    expect(w.state().partyFights.pr?.zone).toBe("rail_embankment");
    const p = w.state().parties.find((x) => x.id === "pr")!;
    expect(partyZoneAt(p, w.state().time)).toBe("rail_embankment");
    expect(p.done).toBe(true);
    expect(p.back.at(-1)?.zone).toBe("c_base");
    w.close();
  });

  it("달아나기가 맞으면 쫓아오지 않고 부대는 갈 길을 간다", () => {
    const w = make();
    const members = engaged(w);
    const r = flee(w, 0.99, { move_to: "rail_embankment" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    for (const id of members) expect(w.state().scene.present).not.toContain(id);
    expect(w.state().partyFights.pr).toBeUndefined();
    w.close();
  });

  it("같은 구역의 다른 장소로 물러나다 빗나가도 맞붙은 부대원이 쫓아온다", () => {
    const w = make();
    const members = engaged(w);
    const to = placesIn(w.state(), content, "a_east_post").find((p) => p.id !== w.state().playerPlace && !p.road)!;
    const r = flee(w, 0.01, { place_to: to.id });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().playerPlace).toBe(to.id);
    for (const id of members) expect(w.state().scene.present).toContain(id);
    expect(w.state().partyFights.pr).toBeTruthy();
    w.close();
  });

  it("전선이 바쁜 날(계획 절반·하루 안 교전·우리 땅의 적 부대)이면 오늘의 일감 한 자리는 전쟁 임무다", () => {
    const w = make();
    const s = w.state();
    expect(frontBusy({ ...s, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { ...c, filled: 0 }])), recentClashes: [], parties: [] }, content, "faction_a")).toBe(false);
    const clocks = Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { ...c, filled: c.factionId === "faction_a" ? c.max : 0 }]));
    expect(frontBusy({ ...s, clocks, recentClashes: [], parties: [] }, content, "faction_a")).toBe(true);
    const clash = { kind: "skirmish" as const, attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: false, attackerLosses: 1, defenderLosses: 0 };
    expect(frontBusy({ ...s, clocks: {}, recentClashes: [{ clash, at: s.time - 60 }], parties: [] }, content, "faction_a")).toBe(true);
    expect(frontBusy({ ...s, clocks: {}, recentClashes: [{ clash, at: s.time - 2 * MINUTES_PER_DAY }], parties: [] }, content, "faction_a")).toBe(false);
    const roles = content.roles.role_a_squad_leader!;
    for (let seed = 1; seed <= 20; seed++) {
      const offers = pickDailyOffers(content, "role_a_squad_leader", MINUTES_PER_DAY * 3, null, createSeededRng(seed), [], false, undefined, roles.rank, undefined, [], false, undefined, true)!;
      expect(offers.templateIds.some((id) => warMission(content.missions[id]!)), `seed ${seed}`).toBe(true);
    }
    w.close();
  });
});

describe("PT33 뒤 고친 것", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt33-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", "role_a_grunt");
  type W = ReturnType<typeof make>;
  const engaged = (w: W) => {
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    const s = w.state();
    const t = s.time;
    const p = party({ id: "pr", faction: "faction_c", kind: "scout", size: 4, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 600, to: t - 300 }, { zone: "rail_embankment", from: t - 300, to: t - 10 }, { zone: "a_east_post", from: t - 10, to: t + 240 }], task: { kind: "watch" } });
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: [p], partiesUpTo: t, clashes: [], scheduled: [] });
    w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties[0]!, "a_east_post", t), player: true, party: false });
    expect(w.executeTool("engage_party", { party_id: "pr" }).ok).toBe(true);
    return w.state().partyFights.pr!.members;
  };
  const flee = (w: W, roll: number, where: { move_to?: string; place_to?: string }) =>
    executeTool("take_action", { intent: "달아난다", check: { move: "athletics", stat: "agility", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, ...where }, { ...w.ctx(), rng: () => roll });
  const seenLines = (w: W) => (w.state().beliefs[w.state().playerId] ?? []).filter((b) => b.fact.includes("지나가는 것을 봤다") || b.fact.includes("자리를 잡는 것을 봤다"));

  it("우리 거점으로 쫓겨 오면 적은 따라 들어오지 않고 물러간다", () => {
    const w = make();
    const members = engaged(w);
    const base = baseOfNow(w.state(), content, "faction_a")!;
    const r = flee(w, 0.01, { move_to: base });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().playerZone).toBe(base);
    expect(r.ok && r.resultText).toContain("물러갔다");
    for (const id of members) expect(w.state().scene.present).not.toContain(id);
    expect(w.state().partyFights.pr).toBeUndefined();
    w.close();
  });

  it("쫓아온 무리는 도착한 구역에서도 눈에 띈 무리로 남고, 맞붙는 동안 '지나가는 것을 봤다'를 쓰지 않으며, 공포가 가라앉지 않는다", () => {
    const w = make();
    engaged(w);
    const before = seenLines(w).length;
    expect(flee(w, 0.01, { move_to: "rail_embankment" }).ok).toBe(true);
    const p = w.state().parties.find((x) => x.id === "pr")!;
    expect(w.state().partySightings[sightKey(p, "rail_embankment", w.state().time)]?.player).toBe(true);
    expect(seenPartiesLines(w.state(), content).join()).toContain("맞붙는 중");
    expect(seenLines(w).length).toBe(before);
    expect(fearSourcePresent(w.ctx())).toBe(true);
    w.close();
  });

  it("맞붙음이 끝나면 한 줄로 남고, 우리 땅에서 맞붙은 일은 교전 기록이 된다", () => {
    const w = make();
    const members = engaged(w);
    for (const id of members.slice(0, 2)) {
      const c = w.state().characters[id]!;
      w.ctx().store.append({ type: "condition_changed", targetId: id, track: content.scenario.harm_track, from: c.conditions[content.scenario.harm_track] ?? "none", to: "serious", fatal: false, by: w.state().playerId, cause: "test", day: 1, harmTrack: true });
    }
    w.runCheat("~time +1h");
    expect(w.state().partyFights.pr).toBeUndefined();
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.fact.includes("맞붙었다") && b.fact.includes("무너져 달아났다"))).toBe(true);
    expect(w.state().recentClashes.some((r) => r.clash.kind === "skirmish" && r.clash.zone === "a_east_post" && r.clash.attacker === "faction_c" && r.clash.defender === "faction_a")).toBe(true);
    expect(warCauses(w.state(), content, "faction_a").traces).toBe("a_east_post");
    w.close();
  });

  it("빈 땅을 차지한 일은 싸움터 수습하기·전선이 바쁜 날의 교전이 아니다", () => {
    const w = make();
    const s = w.state();
    const occupy = { kind: "occupy" as const, attacker: "faction_a", defender: null, zone: "rail_embankment", success: true, attackerLosses: 0, defenderLosses: 0 };
    const st = { ...s, recentClashes: [{ clash: occupy, at: s.time - 60 }], clocks: {}, parties: [] };
    expect(warCauses(st, content, "faction_a").traces).toBeUndefined();
    expect(frontBusy(st, content, "faction_a")).toBe(false);
    w.close();
  });

  it("부대의 나가는 길은 가장 싼 길보다 한 칸 안쪽으로 긴 갈래 길 가운데서 고른다", () => {
    const w = fresh();
    const best = partyRoute(content, w, "faction_c", "c_base", "a_base")!;
    const paths = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const r = detourRoute(content, w, "faction_c", "c_base", "a_base", createSeededRng(seed))!;
      expect(r[0]).toBe("c_base");
      expect(r.at(-1)).toBe("a_base");
      expect(new Set(r).size).toBe(r.length);
      paths.add(r.join(">"));
    }
    expect(paths.size).toBeGreaterThan(1);
    expect(paths.has(best.join(">"))).toBe(true);
  });
});

describe("④ 알리기·맞받아치기·분대 가로막기 (5-3·5-4)", () => {
  const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-four-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", role);
  type W = ReturnType<typeof make>;
  const raiders = (w: W) => {
    const s = w.state();
    const t = s.time;
    const p = party({ id: "pr", faction: "faction_c", kind: "raid", size: 4, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 60, to: t - 30 }, { zone: "rail_embankment", from: t - 30, to: t + 600 }, { zone: "a_east_post", from: t + 600, to: t + 660 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } });
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: [p], partiesUpTo: t, clashes: [], scheduled: [] });
    w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties[0]!, "rail_embankment", t), player: true, party: false });
  };
  const toBase = (w: W) => w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseOfNow(w.state(), content, "faction_a")!, place: null });

  it("본 무리를 거점에서 알리면 그 무리가 노리는 우리 구역을 더 지키고, 같은 무리는 다시 알리지 못한다", () => {
    const w = make();
    raiders(w);
    toBase(w);
    expect(seenPartiesLines(w.state(), content)).toEqual([]);
    const r = w.executeTool("alert_party", { party_id: "pr" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().zones.a_east_post!.alerted).toBe("faction_a");
    expect(w.state().partyAlerts).toHaveLength(1);
    expect(w.executeTool("alert_party", { party_id: "pr" }).ok).toBe(false);
    // 알린 구역은 지키는 몫이 20% → 30%
    const world = { ...fresh(), zones: structuredClone(w.state().zones) };
    const plain = { ...fresh() };
    expect(clashForces(world, { kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post" }, content).defenders).toBeGreaterThan(clashForces(plain, { kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post" }, content).defenders);
    w.close();
  });

  it("알린 무리가 와서 막히면 공적 +1과 소식", () => {
    const w = make();
    raiders(w);
    toBase(w);
    expect(w.executeTool("alert_party", { party_id: "pr" }).ok).toBe(true);
    const merit = w.state().characters[w.state().playerId]!.merit;
    settlePartyAlerts(w.ctx(), [{ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: false, attackerLosses: 2, defenderLosses: 0 }]);
    expect(w.state().characters[w.state().playerId]!.merit).toBe(merit + 1);
    expect(w.state().partyAlerts[0]!.credited).toBe(true);
    expect(w.state().zones.a_east_post!.alerted).toBeUndefined();
    w.close();
  });

  it("윗사람을 설득하면 무리가 가로막을 부대를 낸다", () => {
    const w = make();
    raiders(w);
    toBase(w);
    const boss = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: boss, action: "enter" });
    const r = executeTool("alert_party", { party_id: "pr", persuade: true, approach: "persuade", stat: "charm", intent: "철길 둑에서 막자" }, { ...w.ctx(), rng: () => 0.99 });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const sent = w.state().parties.find((p) => p.task.kind === "intercept");
    expect(sent).toBeTruthy();
    expect(sent).toMatchObject({ faction: "faction_a", goal: "a_east_post", size: 4 });
    expect(w.state().partyAlerts[0]!.persuaded).toBe("success");
    w.close();
  });

  it("가로막는 부대는 숨어 기다리다 지나가는 적대 무리를 보면 치고, 남의 땅에서도 매복한다", () => {
    let fought = 0;
    for (let seed = 1; seed <= 10; seed++) {
    const w = fresh();
    const t = 0;
    const enemy = party({ id: "pe", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", legs: [{ zone: "c_base", from: t, to: t }, { zone: "rail_embankment", from: t, to: t + 120 }, { zone: "a_east_post", from: t + 120, to: t + 180 }], task: { kind: "watch" } });
    w.parties = [enemy];
    const ours = spawnIntercept(w, content, { faction: "faction_a", from: "a_east_post", goal: "rail_embankment", size: 4, at: t - 120, until: t + 300, squad: ["a_dongwook", "a_byungchul", "a_yejin", "a_haneul"], by: "me", leader: "a_dongwook" })!;
    expect(hidingAt(ours, ours.legs.at(-1)!.to)).toBe(true);
    const r = advanceParties(w, content, createSeededRng(seed), t + 400);
    const after = (w.parties ?? []).find((p) => p.id === ours.id)!;
    expect(after.met).toContain("pe");
    if (after.task.kind === "intercept" && after.task.result) {
      fought++;
      expect(after.task.result.enemy).toBe("pe");
      expect(r.clashes.some((c) => c.squad)).toBe(true);
      // 분대원이 쓰러져도 무리 인원은 줄지 않는다 (다침으로 보고)
      expect(w.factions.faction_a!.population).toBe(fresh().factions.faction_a!.population);
    }
    }
    expect(fought).toBeGreaterThan(5);
  });

  it("분대 가로막기: 나선 분대원이 한 무리가 되고, 아무도 안 오면 '아무도 오지 않았다'로 돌아온다", () => {
    const w = make("role_a_squad_leader");
    const squad = content.roles.role_a_squad_leader!.squad!.slice(0, 2);
    for (const id of squad) w.executeTool("npc_presence", { npc_id: id, action: "enter" });
    const r = w.executeTool("squad_order", { members: squad, task: "intercept", zone: "rail_embankment" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const sent = w.state().parties.find((p) => p.task.kind === "intercept")!;
    expect(sent).toMatchObject({ faction: "faction_a", goal: "rail_embankment", size: 2, leader: squad[0] });
    // 지나가는 무리를 모두 치운다
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: [sent], partiesUpTo: s.time, clashes: [], scheduled: [] });
    w.runCheat("~time +7h");
    expect(w.state().parties.find((p) => p.id === sent.id)).toBeUndefined();
    expect(Object.keys(w.state().squadOrders ?? {})).not.toContain(squad[0]);
    const reports = JSON.stringify(w.state().squadReports ?? w.state());
    expect(reports).toContain("아무도 오지 않았다");
    w.close();
  });
});

describe("PT34 뒤 고친 것", () => {
  const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt34-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", role);
  type W = ReturnType<typeof make>;
  const putParties = (w: W, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };
  const scoutAt = (w: W, zone: string, id = "pe") => {
    const t = w.state().time;
    return party({ id, faction: "faction_c", kind: "scout", size: 3, goal: zone, legs: [{ zone: "c_base", from: t - 300, to: t - 200 }, { zone, from: t - 200, to: t + 600 }], task: { kind: "watch" } });
  };

  it("우리 땅에 든 적 부대는 지키는 사람이 알아채 소식이 돌고, 그 구역을 더 지키며, 알릴 수 있는 무리가 된다. 떠나면 거둔다", () => {
    const w = make();
    putParties(w, [scoutAt(w, "a_east_post")]);
    runGarrisonWatch(w.ctx());
    expect(w.state().partiesSeen.pe).toBeDefined();
    expect(w.state().zones.a_east_post!.alerted).toBe("faction_a");
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.fact.includes("지키는 사람들이 알려 왔다"))).toBe(true);
    runGarrisonWatch(w.ctx());
    expect((w.state().beliefs[w.state().playerId] ?? []).filter((b) => b.fact.includes("지키는 사람들이 알려 왔다"))).toHaveLength(1);
    putParties(w, []);
    runGarrisonWatch(w.ctx());
    expect(w.state().zones.a_east_post!.alerted).toBeUndefined();
    w.close();
  });

  it("분대 정찰로 안 무리도 알릴 수 있고, 물러간 무리는 하루 안이면 알리기만 된다 (설득은 안 된다)", () => {
    const w = make();
    putParties(w, [scoutAt(w, "rail_embankment")]);
    w.ctx().store.append({ type: "party_reported", partyId: "pe", via: "squad", zone: "rail_embankment" });
    expect(alertablePartiesLines(w.state(), content).join()).toContain("pe");
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseOfNow(w.state(), content, "faction_a")!, place: null });
    putParties(w, []);
    expect(alertablePartiesLines(w.state(), content).join()).toContain("이미 물러감");
    w.executeTool("npc_presence", { npc_id: content.roles.role_a_grunt!.commander!, action: "enter" });
    const p = w.executeTool("alert_party", { party_id: "pe", persuade: true, approach: "persuade", stat: "charm" });
    expect(!p.ok && p.error).toContain("이미 물러갔다");
    expect(w.executeTool("alert_party", { party_id: "pe" }).ok).toBe(true);
    // 철길 둑을 살핀 정찰: 맞닿은 우리 땅(동쪽 초소)을 하루 더 지킨다
    expect(w.state().zones.a_east_post!.alerted).toBe("faction_a");
    w.close();
  });

  it("가로막는 부대는 나가는 길·출발 구역에서는 마주치지 않고 목표에 닿은 뒤에만", () => {
    const w = fresh();
    const enemy = party({ id: "pe", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", legs: [{ zone: "c_base", from: -100, to: -50 }, { zone: "a_east_post", from: -50, to: 600 }], task: { kind: "watch" } });
    w.parties = [enemy];
    const ours = spawnIntercept(w, content, { faction: "faction_a", from: "a_east_post", goal: "rail_embankment", size: 3, at: 0, until: 400, squad: ["a_dongwook", "a_byungchul", "a_yejin"], by: "me", leader: "a_dongwook" })!;
    advanceParties(w, content, createSeededRng(1), 500);
    expect((w.parties ?? []).find((p) => p.id === ours.id)!.met).not.toContain("pe");
  });

  it("분대 일을 나간 사람은 장소의 '있을 사람'이 아니다", () => {
    const w = make("role_a_squad_leader");
    const id = content.roles.role_a_squad_leader!.squad![0]!;
    w.executeTool("npc_presence", { npc_id: id, action: "enter" });
    expect(w.executeTool("squad_order", { members: [id], task: "scout", zone: "rail_embankment" }).ok).toBe(true);
    expect(whereIs(w.state(), content, id)).toEqual({ zone: "rail_embankment", place: null });
    w.close();
  });

  it("세계가 열릴 때 싸움 거는 무리의 공격 계획은 절반~8할쯤 차 있고, 나머지는 비어 있다", () => {
    const w = make();
    const s = w.state();
    for (const [id, c] of Object.entries(s.clocks)) {
      const f = content.factions[c.factionId]!;
      const plan = f.plans.find((p) => p.id === id)!;
      if ((f.aggression ?? 0) > 0 && plan.kind !== "shift") expect(c.filled, id).toBeGreaterThanOrEqual(Math.floor(c.max * 0.5));
      else expect(c.filled, id).toBe(0);
    }
    w.close();
  });

  it("정찰은 적 땅만이 아니라 적 땅으로 가는 길목으로도 나간다", () => {
    const goals = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const w = fresh();
      spawnWatchParties(w, content, createSeededRng(seed), 2);
      for (const p of w.parties ?? []) if (p.faction === "faction_c" && p.kind === "scout") goals.add(p.goal);
    }
    expect(goals.size).toBeGreaterThan(1);
    expect([...goals].some((g) => g !== "a_east_post")).toBe(true);
  });
});

describe("PT35 뒤 고친 것", () => {
  const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt35-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", role);
  type W = ReturnType<typeof make>;
  const putParties = (w: W, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };

  it("분대 가로막기 부대를 내면 부대 번호가 오르고, 그 뒤 생기는 부대와 id가 겹치지 않는다", () => {
    const w = make("role_a_squad_leader");
    const squad = content.roles.role_a_squad_leader!.squad!.slice(0, 2);
    for (const id of squad) w.executeTool("npc_presence", { npc_id: id, action: "enter" });
    const before = w.state().nextPartyNo;
    expect(w.executeTool("squad_order", { members: squad, task: "intercept", zone: "rail_embankment" }).ok).toBe(true);
    expect(w.state().nextPartyNo).toBe(before + 1);
    w.runCheat("~time +30h");
    const ids = w.state().parties.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    w.close();
  });

  it("알린 무리도 윗사람 앞에서 한 번은 맞받아치자고 설득할 수 있다", () => {
    const w = make();
    const t = w.state().time;
    putParties(w, [party({ id: "pr", faction: "faction_c", kind: "raid", size: 4, goal: "a_east_post", legs: [{ zone: "c_base", from: t - 60, to: t - 30 }, { zone: "rail_embankment", from: t - 30, to: t + 600 }, { zone: "a_east_post", from: t + 600, to: t + 660 }], task: { kind: "clash", clash: "raid", defender: "faction_a" } })]);
    w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties[0]!, "rail_embankment", t), player: true, party: false });
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseOfNow(w.state(), content, "faction_a")!, place: null });
    expect(w.executeTool("alert_party", { party_id: "pr" }).ok).toBe(true);
    expect(w.executeTool("alert_party", { party_id: "pr" }).ok).toBe(false);
    w.executeTool("npc_presence", { npc_id: content.roles.role_a_grunt!.commander!, action: "enter" });
    const r = executeTool("alert_party", { party_id: "pr", persuade: true, approach: "persuade", stat: "charm" }, { ...w.ctx(), rng: () => 0.99 });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().partyAlerts).toHaveLength(1);
    expect(w.state().partyAlerts[0]!.persuaded).toBe("success");
    expect(executeTool("alert_party", { party_id: "pr", persuade: true, approach: "persuade", stat: "charm" }, w.ctx()).ok).toBe(false);
    w.close();
  });

  it("지키는 사람이 늦게 알게 된 무리는 '왔다 갔다'로만 알리고, 알릴 무리·더 지킬 곳이 되지 않는다", () => {
    const w = make();
    const t = w.state().time;
    putParties(w, [party({ id: "pe", faction: "faction_c", kind: "scout", size: 3, goal: "a_east_post", done: true, legs: [{ zone: "c_base", from: t - 600, to: t - 500 }, { zone: "a_east_post", from: t - 500, to: t - 200 }], back: [{ zone: "rail_embankment", from: t - 200, to: t + 300 }], task: { kind: "watch" } })]);
    runGarrisonWatch(w.ctx());
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.fact.includes("왔다 갔다"))).toBe(true);
    expect(w.state().partiesSeen.pe).toBeUndefined();
    expect(w.state().zones.a_east_post!.alerted).toBeUndefined();
    w.close();
  });

  it("목표를 이미 차지한 계획은 다른 목표를 고른다", () => {
    const w = fresh();
    w.zones.a_east_post = { owner: "faction_c" };
    w.clocks.c_east_offensive!.target = "a_east_post";
    const r = simulateWarDay(w, content, createSeededRng(1), { day: 2 });
    expect(r.clocks.c_east_offensive!.target).not.toBe("a_east_post");
  });

  it("앞당긴 계획이 빈 땅 차지로 터져도 '덕분에'가 실린다", () => {
    const w = fresh();
    w.clocks.a_counteroffensive!.credits = [{ by: "me", mission: "전선 정찰", scout: true }];
    const p = spawnParty(w, content, createSeededRng(2), { faction: "faction_a", kind: "patrol", goal: "rail_embankment", size: 4, dayStart: 0, task: { kind: "occupy", plan: "a_counteroffensive", credits: [{ by: "me", mission: "전선 정찰" }] } })!;
    const r = advanceParties(w, content, createSeededRng(2), arrivalOf(p));
    expect(r.clashes.find((c) => c.kind === "occupy")?.credits).toEqual([{ by: "me", mission: "전선 정찰" }]);
  });

  it("공세 부대가 모여 있으면 계획 줄은 '부대가 거점에 모였다'이고 '새벽에 함께 나설 수 있다'는 없다", () => {
    const w = make();
    const t = w.state().time;
    putParties(w, [party({ id: "pa", faction: "faction_a", kind: "assault", size: 10, goal: "c_warehouse", legs: [{ zone: "a_base", from: t - 60, to: t + 600 }, { zone: "a_east_post", from: t + 600, to: t + 700 }, { zone: "c_warehouse", from: t + 700, to: t + 800 }], task: { kind: "clash", clash: "assault", defender: "faction_c", plan: "a_counteroffensive" } })]);
    const plan = factionOutlook(w.state(), content).own!.plans.find((p) => p.label === w.state().clocks.a_counteroffensive!.label)!;
    expect(plan.stage).toContain("거점에 모였다");
    expect(describePlayerState(w.state(), content)).not.toContain("새벽에 함께 나설");
    w.close();
  });

  it("일과 자리를 적대하는 무리가 빼앗으면 그 사람은 자기 무리 거점으로 물러나 있다", () => {
    const w = make();
    const s = w.state();
    const before = whereIs(s, content, "a_seoyeon");
    expect(before?.zone).toBe("a_east_post");
    const zones = { ...s.zones, a_east_post: { owner: "faction_c" } };
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: s.parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
    expect(whereIs(w.state(), content, "a_seoyeon")?.zone).toBe(baseOfNow(w.state(), content, "faction_a"));
    w.close();
  });
});

describe("알리기 구조 (12-327)", () => {
  const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-alert-")), content, rngFactory: () => createSeededRng(9) }).create("mcp", "role_a_grunt");
  type W = ReturnType<typeof make>;
  const putParties = (w: W, parties: Party[]) => {
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties, partiesUpTo: s.time, clashes: [], scheduled: [] });
  };
  const seenScout = (w: W, goal: string, plan?: string) => {
    const t = w.state().time;
    putParties(w, [party({ id: "ps", faction: "faction_c", kind: "scout", size: 3, goal, legs: [{ zone: "c_base", from: t - 300, to: t - 200 }, { zone: goal, from: t - 200, to: t + 300 }], task: { kind: "watch", ...(plan ? { plan } : {}) } })]);
    w.ctx().store.append({ type: "party_sighted", key: sightKey(w.state().parties[0]!, goal, t), player: true, party: false });
  };

  it("우리 땅의 우리 사람 앞이면 초소에서도 알리고, 공세를 앞둔 정찰이면 그 공세의 목표를 하루 동안 더 지킨다", () => {
    const w = make();
    seenScout(w, "rail_embankment", "c_east_offensive");
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "a_east_post", place: "trench" });
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_a" && n.rank === "grunt")!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const r = w.executeTool("alert_party", { party_id: "ps" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("하루 동안");
    const target = w.state().clocks.c_east_offensive!.target;
    expect(w.state().zones[target]!.alerted).toBe("faction_a");
    expect(w.state().partyAlerts[0]!.until).toBe(w.state().time + MINUTES_PER_DAY);
    w.close();
  });

  it("하루가 지나면 더 지키던 것을 거두고, 그 안에 막히면 공적", () => {
    const w = make();
    seenScout(w, "a_east_post");
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseOfNow(w.state(), content, "faction_a")!, place: null });
    expect(w.executeTool("alert_party", { party_id: "ps" }).ok).toBe(true);
    const merit = w.state().characters[w.state().playerId]!.merit;
    settlePartyAlerts(w.ctx(), [{ kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: false, attackerLosses: 3, defenderLosses: 1 }]);
    expect(w.state().characters[w.state().playerId]!.merit).toBe(merit + 1);
    const w2 = make();
    seenScout(w2, "a_east_post");
    w2.ctx().store.append({ type: "zone_moved", from: w2.state().playerZone, to: baseOfNow(w2.state(), content, "faction_a")!, place: null });
    expect(w2.executeTool("alert_party", { party_id: "ps" }).ok).toBe(true);
    const t = w2.state().time;
    w2.ctx().store.append({ type: "time_advanced", activity: "brief", from: t, to: t + MINUTES_PER_DAY + 60 });
    settlePartyAlerts(w2.ctx(), []);
    expect(w2.state().zones.a_east_post!.alerted).toBeUndefined();
    expect(w2.state().partyAlerts[0]!.closed).toBe(true);
    w.close();
    w2.close();
  });

  it("본 지 하루가 넘은 무리는 알릴 수 없다", () => {
    const w = make();
    seenScout(w, "a_east_post");
    const t = w.state().time;
    w.ctx().store.append({ type: "time_advanced", activity: "brief", from: t, to: t + MINUTES_PER_DAY + 60 });
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: baseOfNow(w.state(), content, "faction_a")!, place: null });
    const r = w.executeTool("alert_party", { party_id: "ps" });
    expect(!r.ok && r.error).toContain("하루가 넘은");
    w.close();
  });
});
