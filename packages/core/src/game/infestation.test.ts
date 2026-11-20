import { describe, expect, it } from "vitest";
import { createWorldEvent, type Clash } from "./state.ts";
import { InMemoryGameStore } from "./store.ts";
import { baseInfestation, infestationDay, infestationOf, infestationSign } from "./infestation.ts";
import { routeDanger } from "../story/storylets.ts";
import { describeExtraTemplates } from "../engine/extras.ts";
import { dayOf } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";

/** 구역의 감염체 압력 (12-112) */
// 소음이 다음 날에 오르는 하루 틱을 본다 (몰려드는 시간 swarm_hours는 플레이 테스트 12의 테스트에서)
const real0 = loadRealContent();
const content = { ...real0, storylets: {}, scenario: { ...real0.scenario, infestation: { ...real0.scenario.infestation!, swarm_hours: undefined } } };
const zones = Object.values(content.locations);
const calm = zones.find((l) => l.danger === 0 && !l.isolated)!;
const wild = zones.find((l) => l.danger === 2 && !l.isolated)!;

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_l_wanderer", "world_infest", () => 0.5)]);
  return { store, state: () => store.getState() };
}
const clash = (zone: string, losses: number): Clash => ({ kind: "skirmish", attacker: "faction_c", defender: "faction_a", zone, success: false, attackerLosses: losses, defenderLosses: 0 });

describe("감염체 압력", () => {
  it("기준값은 구역의 위험이다", () => {
    const { state } = setup();
    expect(infestationOf(content, state(), wild.id)).toBe(wild.danger);
    expect(baseInfestation(content, calm.id)).toBe(0);
  });

  it("전날의 총소리와 그날의 시체로 오른다 (최대 3). 기준값에 있는 구역은 난수를 쓰지 않는다", () => {
    const { store, state } = setup();
    const day = dayOf(state().time) + 1;
    store.append({ type: "noise_made", zone: calm.id, level: 2, day: day - 1 });
    let rolls = 0;
    const changes = infestationDay(content, state(), day, [clash(calm.id, 3), clash(wild.id, 1)], () => (rolls++, 0.5));
    expect(changes).toEqual([{ zone: calm.id, level: 2, cause: "소음·시체" }]);
    expect(rolls).toBe(0);
    // 이틀 전 소음은 세지 않는다
    expect(infestationDay(content, state(), day + 1, [], () => 0.99)).toEqual([]);
  });

  it("아무 일 없는 날은 확률로 기준값 쪽으로 한 단계 돌아간다 (위로도 아래로도)", () => {
    const { store, state } = setup();
    store.append({ type: "infestation_changed", zone: calm.id, level: 2, cause: "소음" });
    store.append({ type: "infestation_changed", zone: wild.id, level: 0, cause: "소탕" });
    const day = dayOf(state().time) + 1;
    expect(infestationDay(content, state(), day, [], () => 0.99)).toEqual([]);
    expect(infestationDay(content, state(), day, [], () => 0)).toEqual(
      expect.arrayContaining([
        { zone: calm.id, level: 1, cause: "흩어짐" },
        { zone: wild.id, level: 1, cause: "흩어짐" },
      ]),
    );
  });

  it("날이 바뀌면 하루 틱이 압력을 바꾼다", async () => {
    const { WorldManager } = await import("../world/manager.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSeededRng } = await import("../rng.ts");
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-infest-")), content, rngFactory: () => createSeededRng(3) });
    const w = m.create("mcp", "role_l_wanderer", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
    const zone = w.state().playerZone!;
    const before = infestationOf(content, w.state(), zone);
    w.ctx().store.append({ type: "noise_made", zone, level: 3, day: dayOf(w.state().time) });
    w.runCheat("~time +1d");
    expect(infestationOf(content, w.state(), zone)).toBeGreaterThan(Math.min(before, 2));
    w.close();
  });

  it("길의 위험과 감염체 틀 등장에 더해진다", () => {
    const { store, state } = setup();
    const s = state();
    s.lastRoute = { from: calm.id, to: calm.id };
    expect(routeDanger(content, s)).toBe(0);
    store.append({ type: "infestation_changed", zone: calm.id, level: 3, cause: "소음" });
    const t = state();
    t.lastRoute = { from: calm.id, to: calm.id };
    expect(routeDanger(content, t)).toBe(3);
    t.playerZone = calm.id;
    expect(describeExtraTemplates(t, content)).toContain("infected_hungry");
  });

  it("GM에게는 숫자 대신 그 구역에서 보이는 흔적만 간다", () => {
    const { store, state } = setup();
    expect(infestationSign(content, state(), calm.id)).toBeNull();
    store.append({ type: "infestation_changed", zone: calm.id, level: 1, cause: "소음" });
    expect(infestationSign(content, state(), calm.id)).toContain("평소보다 많다");
    store.append({ type: "infestation_changed", zone: wild.id, level: 0, cause: "소탕" });
    expect(infestationSign(content, state(), wild.id)).toContain("드물다");
    expect(infestationSign(content, state(), wild.id)).not.toMatch(/\d/);
  });

  it("감염체가 몰려든 구역은 덜 거둔다: 기준값보다 한 단계 높을 때마다 산출 yields_cut만큼 (12-118)", async () => {
    const { initialWarWorld, simulateWarDay } = await import("../sim/war.ts");
    const quiet = structuredClone(content);
    for (const f of Object.values(quiet.factions)) f.aggression = 0;
    const farm = Object.values(quiet.locations).find((l) => l.owner && (l.yields.food ?? 0) >= 20)!;
    const day = (infested: Record<string, number>) =>
      simulateWarDay(initialWarWorld(quiet), quiet, () => 0.5, { infested }).factions[farm.owner!]!.resources.food ?? 0;
    const calm = day({});
    const two = day({ [farm.id]: Math.min(3, baseInfestation(quiet, farm.id) + 2) });
    const cut = quiet.scenario.infestation!.yields_cut;
    const overrun = Math.min(3, baseInfestation(quiet, farm.id) + 2) - baseInfestation(quiet, farm.id);
    expect(cut).toBeGreaterThan(0);
    expect(calm - two).toBeGreaterThan(0);
    expect(calm - two).toBeLessThanOrEqual(Math.ceil((farm.yields.food ?? 0) * 1.2 * cut * overrun) + 1);
  });

  it("자기 거점에 감염체가 몰려들면 그 무리의 사기가 흔들린다 (12-120)", async () => {
    const { initialWarWorld, simulateWarDay } = await import("../sim/war.ts");
    const quiet = structuredClone(content);
    for (const f of Object.values(quiet.factions)) f.aggression = 0;
    const base = Object.values(quiet.locations).find((l) => l.kind === "base" && l.owner)!;
    const world = initialWarWorld(quiet);
    const before = world.factions[base.owner!]!.morale;
    const calm = simulateWarDay(world, quiet, () => 0, { infested: {} }).factions[base.owner!]!.morale;
    const besieged = simulateWarDay(world, quiet, () => 0, { infested: { [base.id]: baseInfestation(quiet, base.id) + 1 } }).factions[base.owner!]!.morale;
    expect(besieged).toBe(Math.max(-3, calm - 1));
    expect(calm).toBeLessThanOrEqual(before + 1);
  });

  it("땅에 감염체가 몰려든 무리는 형편(9.13)에 오른다: 기준값보다 높은 만큼 말이 세진다 (12-120)", async () => {
    const { troublesOf } = await import("../engine/factionTalk.ts");
    const { initialWarWorld } = await import("../sim/war.ts");
    const { store, state } = setup();
    const world = initialWarWorld(content);
    state().factions = world.factions;
    state().zones = world.zones;
    const own = Object.values(content.locations).find((l) => l.owner === "faction_a" && l.danger <= 1)!;
    expect(troublesOf(state(), content, "faction_a").some((t) => t.kind === "infested")).toBe(false);
    store.append({ type: "infestation_changed", zone: own.id, level: own.danger + 1, cause: "소음" });
    const one = troublesOf(state(), content, "faction_a").find((t) => t.kind === "infested")!;
    expect(one.level).toBe(0);
    expect(one.text).toContain(own.name);
    store.append({ type: "infestation_changed", zone: own.id, level: own.danger + 2, cause: "소음" });
    expect(troublesOf(state(), content, "faction_a").find((t) => t.kind === "infested")!.level).toBe(1);
  });

  it("담 밖의 전조는 우리 구역에 감염체가 평소보다 몰려들었을 때만 열린다 (12-123)", async () => {
    const { conditionsMet } = await import("../story/storylets.ts");
    const { initialWarWorld } = await import("../sim/war.ts");
    const real = loadRealContent();
    const omen = real.storylets.w_omen_tracks!;
    const store = new InMemoryGameStore([createWorldEvent(real, "role_a_grunt", "world_omen", () => 0.5)]);
    const s = store.getState();
    const w = initialWarWorld(real);
    s.factions = w.factions;
    s.zones = w.zones;
    s.playerZone = "a_base";
    const morning = Math.floor(s.time / 1440) * 1440 + 7 * 60;
    expect(conditionsMet(s, real, omen, morning)).toBe(false);
    store.append({ type: "infestation_changed", zone: "a_base", level: baseInfestation(real, "a_base") + 1, cause: "소음" });
    const t = store.getState();
    t.factions = w.factions;
    t.zones = w.zones;
    t.playerZone = "a_base";
    expect(conditionsMet(t, real, omen, morning)).toBe(true);
  });
});
