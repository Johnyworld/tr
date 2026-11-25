import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { WorldManager } from "../world/manager.ts";
import { advanceParties, arrivalOf, canSend, maxParties, partiesConfig, partyRoute, partyZoneAt, returnOf, spawnParty } from "./parties.ts";
import { initialWarWorld, simulateWarDay, type WarWorld } from "./war.ts";

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

  it("플레이어가 낄 교전은 닿는 시각으로 미루고, 부대는 흩어져 전투원으로 돌아간다", () => {
    const w = fresh();
    const rng = createSeededRng(7);
    const total = w.factions.faction_c!.combatants;
    const p = spawnParty(w, content, rng, { faction: "faction_c", kind: "raid", goal: "a_east_post", size: 8, dayStart: 0, task: { kind: "clash", clash: "raid", defender: "faction_a" } })!;
    const r = advanceParties(w, content, rng, arrivalOf(p), { defer: () => true });
    expect(r.clashes).toEqual([]);
    expect(r.deferred).toEqual([{ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", at: arrivalOf(p) }]);
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
