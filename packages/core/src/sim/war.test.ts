import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { initialWarWorld, neighbors, simulateWarDay, type WarWorld } from "./war.ts";

/** 공격 성향을 모두 끈 콘텐츠 (소모·생산·클락만 본다) */
function peaceful(): Content {
  const content = structuredClone(TEST_CONTENT);
  for (const f of Object.values(content.factions)) f.aggression = 0;
  return content;
}

function run(world: WarWorld, content: Content, days: number, seed = 1) {
  const rng = createSeededRng(seed);
  const clashes = [];
  for (let i = 0; i < days; i++) {
    const r = simulateWarDay(world, content, rng);
    clashes.push(...r.clashes);
    world = { factions: r.factions, zones: r.zones, clocks: r.clocks };
  }
  return { world, clashes };
}

describe("세력 시작값", () => {
  it("콘텐츠에서 세력·구역·클락을 만든다. 없는 자원은 0", () => {
    const w = initialWarWorld(TEST_CONTENT);
    expect(w.factions.faction_e?.resources).toEqual({ food: 100, bullets: 0, meds: 0 });
    expect(w.zones.wild).toEqual({ owner: null });
    expect(w.clocks.c_plan).toEqual({ factionId: "faction_c", label: "비밀 공세 준비", target: "a_post", filled: 0, max: 3 });
  });

  it("인접은 한쪽에만 적어도 양쪽으로 본다", () => {
    expect(neighbors(TEST_CONTENT, "wild")).toEqual(["a_home", "c_home"]);
    expect(neighbors(TEST_CONTENT, "a_post")).toEqual(["a_home", "c_home"]);
  });
});

describe("하루 틱: 생산과 소모", () => {
  it("소유 구역의 산출을 더하고 인원수만큼 소모한다", () => {
    const content = peaceful();
    const { world } = run(initialWarWorld(content), content, 1);
    expect(world.factions.faction_a?.resources.food).toBe(400 + 10 - 20);
    expect(world.factions.faction_c?.resources.food).toBe(2000 + 50 - 60);
  });

  it("생존 자원이 모자라면 바닥나고, 사기가 떨어지고, 사람이 죽는다", () => {
    const content = peaceful();
    const start = initialWarWorld(content);
    start.factions.faction_a!.resources.food = 5;
    const { world } = run(start, content, 1);
    const a = world.factions.faction_a!;
    expect(a.resources.food).toBe(0);
    expect(a.morale).toBe(0);
    expect(a.population).toBe(19);
  });

  it("굶지 않으면 잃은 전투원을 남은 사람 중에서 다시 키운다 (끝없는 세계)", () => {
    const content = peaceful();
    content.factions.faction_a!.plans = [];
    content.factions.faction_c!.plans = [];
    const start = initialWarWorld(content);
    start.factions.faction_a!.combatants = 2;
    const { world } = run(start, content, 30);
    expect(world.factions.faction_a!.combatants).toBeGreaterThan(2);
    // 처음 전투원 비율(절반)까지만 키운다. 피란민이 합류하면 인원도 는다
    const a = world.factions.faction_a!;
    expect(a.combatants).toBeLessThanOrEqual(Math.round(a.population / 2));
    expect(a.population).toBeGreaterThanOrEqual(20);
  });

  it("입력을 바꾸지 않는다", () => {
    const start = initialWarWorld(TEST_CONTENT);
    const before = JSON.stringify(start);
    simulateWarDay(start, TEST_CONTENT, createSeededRng(1));
    expect(JSON.stringify(start)).toBe(before);
  });
});

describe("세력 클락", () => {
  it("하루에 한 칸씩 차고, 다 차면 목표 구역을 총공격한 뒤 다시 시작한다", () => {
    const content = peaceful();
    const { world, clashes } = run(initialWarWorld(content), content, 3);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post", plan: "c_plan" });
    expect(world.clocks.c_plan?.filled).toBe(0);
  });
});

describe("교전", () => {
  it("같은 시드면 같은 결과다 (결정적)", () => {
    const a = run(initialWarWorld(TEST_CONTENT), TEST_CONTENT, 20, 7);
    const b = run(initialWarWorld(TEST_CONTENT), TEST_CONTENT, 20, 7);
    expect(a).toEqual(b);
  });

  it("오래 돌려도 거점은 빼앗기지 않고, 값은 범위 안에 있다", () => {
    for (const seed of [1, 2, 3]) {
      const { world, clashes } = run(initialWarWorld(TEST_CONTENT), TEST_CONTENT, 120, seed);
      expect(clashes.length).toBeGreaterThan(0);
      for (const loc of Object.values(TEST_CONTENT.locations).filter((l) => l.kind === "base")) {
        expect(world.zones[loc.id]?.owner).toBe(loc.owner);
      }
      for (const f of Object.values(world.factions)) {
        expect(f.population).toBeGreaterThanOrEqual(f.combatants);
        expect(f.combatants).toBeGreaterThanOrEqual(0);
        for (const v of Object.values(f.resources)) expect(Number.isInteger(v) && v >= 0).toBe(true);
        expect(Math.abs(f.morale)).toBeLessThanOrEqual(3);
      }
      // 공격하지 않는 무리(상인단)는 교전에 끼지 않는다 (적대하는 무리가 없다)
      expect(clashes.some((c) => c.attacker === "faction_e" || c.defender === "faction_e")).toBe(false);
    }
  });

  it("공격 성향이 있는 무리는 맞닿은 빈 구역을 차지하고, 적대 세력만 공격한다", () => {
    const { clashes } = run(initialWarWorld(TEST_CONTENT), TEST_CONTENT, 60, 4);
    expect(clashes.some((c) => c.kind === "occupy" && c.attacker === "faction_c" && c.zone === "wild")).toBe(true);
    for (const c of clashes) {
      expect(c.attacker).toBe("faction_c");
      if (c.defender) expect(c.defender).toBe("faction_a");
    }
  });

  it("습격에 성공하면 자원을 빼앗고, 총공격에 성공하면 구역이 넘어간다", () => {
    const content = structuredClone(TEST_CONTENT);
    // A를 거의 무력하게 만들어 성공하는 경우를 본다
    const start = initialWarWorld(content);
    start.factions.faction_a!.combatants = 1;
    const { clashes } = run(start, content, 60, 5);
    const raid = clashes.find((c) => c.kind === "raid" && c.success);
    expect(raid?.loot && Object.values(raid.loot).some((n) => n > 0)).toBe(true);
    const assault = clashes.find((c) => c.kind === "assault" && c.success);
    expect(assault?.zone).toBe("a_post");
  });
});

describe("태도가 바뀌는 클락 (shift)", () => {
  it("다 차면 정한 태도로 바뀌고 소식이 생긴다. 한 번만 일어난다", () => {
    const content = peaceful();
    content.factions.faction_e!.plans = [
      { id: "e_side", label: "편들기", kind: "shift", target_rule: "fixed", days: 2, shift: [{ to: "strongest", value: 2 }], news: "{faction}이 {to} 쪽에 붙었다" },
    ];
    let world = initialWarWorld(content);
    expect(world.factions.faction_e!.disposition).toEqual(content.factions.faction_e!.disposition);
    const rng = createSeededRng(1);
    const day1 = simulateWarDay(world, content, rng);
    expect(day1.shifts).toEqual([]);
    world = { factions: day1.factions, zones: day1.zones, clocks: day1.clocks };
    const day2 = simulateWarDay(world, content, rng);
    expect(day2.shifts).toHaveLength(1);
    const to = day2.shifts[0]!.to;
    expect(to).not.toBe("faction_e");
    expect(day2.factions.faction_e!.disposition?.[to]).toBe(2);
    expect(day2.shifts[0]!.news).toContain("쪽에 붙었다");
    world = { factions: day2.factions, zones: day2.zones, clocks: day2.clocks };
    expect(simulateWarDay(world, content, rng).shifts).toEqual([]);
  });
});

describe("땅이 바뀐 그 자리에서 계획 목표를 다시 고른다 (PT36)", () => {
  it("계획 목표를 차지하면 하루 틱을 기다리지 않고 바로 다른 목표로", async () => {
    const { occupyZone } = await import("./war.ts");
    const w = initialWarWorld(TEST_CONTENT);
    w.zones.a_post = { owner: null };
    occupyZone(w, TEST_CONTENT, "faction_c", "a_post", "c_plan");
    expect(w.zones.a_post?.owner).toBe("faction_c");
    expect(w.clocks.c_plan?.target).not.toBe("a_post");
  });

  it("움직이는 부대의 교전은 실제로 온 인원, 숨어 기다리던 지키는 부대는 지키는 쪽에 든다", async () => {
    const { clashForces } = await import("./war.ts");
    const w = initialWarWorld(TEST_CONTENT);
    const base = clashForces(w, { kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post" }, TEST_CONTENT);
    const moved = clashForces(w, { kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post", force: 21, guard: 11 }, TEST_CONTENT);
    expect(moved.attackers).toBe(21);
    expect(moved.defenders).toBe(base.defenders + 11);
  });
});

describe("PT37 고침", () => {
  it("할 일을 마치고 돌아가는 정찰·운반은 먼저 덤비지 않는다", async () => {
    const { partyChoice } = await import("../rules/encounter.ts");
    expect(partyChoice({ kind: "scout", size: 4, onOwnLand: false }, { size: 1 })).toBe("fight");
    expect(partyChoice({ kind: "scout", size: 4, onOwnLand: false, returning: true }, { size: 1 })).toBe("avoid");
    expect(partyChoice({ kind: "assault", size: 20, onOwnLand: false, returning: true }, { size: 1 })).toBe("fight");
  });

  it("목표를 다시 고르면 그 목표에 쌓인 공은 비운다", async () => {
    const { occupyZone } = await import("./war.ts");
    const w = initialWarWorld(TEST_CONTENT);
    w.zones.a_post = { owner: null };
    w.clocks.c_plan!.credits = [{ by: "p", mission: "경계 재기", scout: true }];
    occupyZone(w, TEST_CONTENT, "faction_c", "a_post", "c_plan");
    expect(w.clocks.c_plan?.credits).toBeUndefined();
  });
});

describe("PT38 고침", () => {
  it("지키는 사람 수: 전투원이 없으면 0, 숨어 기다리던 부대도 든다", async () => {
    const { garrisonAt, clashForces } = await import("./war.ts");
    const w = initialWarWorld(TEST_CONTENT);
    const spec = { kind: "raid" as const, attacker: "faction_c", defender: "faction_a", zone: "a_post" };
    w.factions.faction_a!.combatants = 0;
    expect(garrisonAt(w, spec, TEST_CONTENT)).toBe(0);
    expect(clashForces(w, spec, TEST_CONTENT).defenders).toBe(1);
    expect(garrisonAt(w, { ...spec, guard: 5 }, TEST_CONTENT)).toBe(5);
  });

  it("아침에 낸 일감은 그 자리를 빼앗기거나 노리던 구역이 우리 땅이 되면 빠진다", async () => {
    const { offerStillOpen } = await import("../game/missions.ts");
    const { loadRealContent } = await import("../testing.ts");
    const real = loadRealContent();
    const owners = Object.fromEntries(Object.entries(real.locations).map(([id, l]) => [id, { owner: l.owner ?? null }]));
    expect(offerStillOpen(real, "a_sl_east_reinforce", "faction_a", owners)).toBe(true);
    expect(offerStillOpen(real, "a_sl_east_reinforce", "faction_a", { ...owners, a_east_post: { owner: "faction_c" } })).toBe(false);
    expect(offerStillOpen(real, "c_east_probe", "faction_c", owners)).toBe(true);
    expect(offerStillOpen(real, "c_east_probe", "faction_c", { ...owners, a_east_post: { owner: "faction_c" } })).toBe(false);
  });
});

describe("PT39 고침", () => {
  it("거점을 잃으면 자리 없는 일감이 빠지고, 붙잡아 둔 사람이 없으면 심문 일감이 빠진다", async () => {
    const { offerStillOpen } = await import("../game/missions.ts");
    const { loadRealContent } = await import("../testing.ts");
    const real = loadRealContent();
    const owners = Object.fromEntries(Object.entries(real.locations).map(([id, l]) => [id, { owner: l.owner ?? null }]));
    const noWhere = Object.values(real.missions).find((m) => !m.where && real.roles.role_a_squad_leader!.missions.includes(m.id))!.id;
    expect(offerStillOpen(real, noWhere, "faction_a", owners)).toBe(true);
    expect(offerStillOpen(real, noWhere, "faction_a", { ...owners, a_base: { owner: null } })).toBe(false);
    expect(offerStillOpen(real, "a_of_prisoner", "faction_a", owners, 0)).toBe(false);
    expect(offerStillOpen(real, "a_of_prisoner", "faction_a", owners, 1)).toBe(true);
  });

  it("정해진 상관이 죽으면 같은 무리에서 바로 위 계급인 사람이 상관이 된다", async () => {
    const { commanderOf } = await import("../game/missions.ts");
    const { loadRealContent } = await import("../testing.ts");
    const real = loadRealContent();
    const role = real.roles.role_c_raider!;
    const boss = role.commander!;
    const characters: Record<string, { dead: boolean; rank?: string; factionId?: string | null }> = { me: { dead: false, rank: role.rank, factionId: role.faction } };
    for (const [id, n] of Object.entries(real.npcs)) characters[id] = { dead: false, rank: n.rank, factionId: n.faction };
    const state = { playerId: "me", roleId: "role_c_raider", characters };
    expect(commanderOf(state, real)).toBe(boss);
    characters[boss]!.dead = true;
    const next = commanderOf(state, real);
    expect(next).not.toBeNull();
    expect(next).not.toBe(boss);
    expect(characters[next!]!.factionId).toBe(role.faction);
  });
});
