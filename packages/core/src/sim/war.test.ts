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
