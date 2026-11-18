import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { disposition, hopsFromBase, initialWarWorld, simulateWarDay } from "./war.ts";

/** AI 무리끼리의 휴전과 집에 가까울수록 단단한 전선 (12-146) */
const content = loadRealContent();

describe("AI 무리끼리의 휴전", () => {
  it("크게 밀린 무리는 적대하던 무리와 휴전하고, 휴전 동안은 서로 적대가 아니며, 끝나면 태도가 돌아온다", () => {
    let world = initialWarWorld(content);
    const before = disposition(content, "faction_c", "faction_a", world);
    expect(before).toBeLessThanOrEqual(-2);
    world.factions.faction_a!.population = 20; // 시작 70의 절반 아래
    world.factions.faction_a!.combatants = 5;
    const zero = () => 0;
    let r = simulateWarDay(world, content, zero, {});
    expect(r.shifts.some((s) => s.clockId === "truce" && [s.factionId, s.to].includes("faction_a") && [s.factionId, s.to].includes("faction_c"))).toBe(true);
    world = { factions: r.factions, zones: r.zones, clocks: r.clocks };
    expect(disposition(content, "faction_c", "faction_a", world)).toBe(-1);
    const days = world.factions.faction_c!.truces!.faction_a!.days;
    expect(days).toBeGreaterThanOrEqual(14);
    for (let i = 0; i < days; i++) {
      r = simulateWarDay(world, content, () => 0.99, {});
      world = { factions: r.factions, zones: r.zones, clocks: r.clocks };
    }
    expect(world.factions.faction_c!.truces?.faction_a).toBeUndefined();
    expect(disposition(content, "faction_c", "faction_a", world)).toBe(before);
  });

  it("밀리지 않았으면 휴전하지 않는다", () => {
    const r = simulateWarDay(initialWarWorld(content), content, () => 0, {});
    expect(r.shifts.some((s) => s.clockId === "truce")).toBe(false);
  });
});

describe("집에 가까울수록 단단한 전선", () => {
  it("거점은 0칸, 이웃은 1칸, 그 너머는 더", () => {
    const world = initialWarWorld(content);
    expect(hopsFromBase(content, world, "faction_a", "a_base")).toBe(0);
    const near = content.locations.a_base!.adjacent[0]!;
    expect(hopsFromBase(content, world, "faction_a", near)).toBe(1);
    expect(hopsFromBase(content, world, "faction_a", "yeoul_isle")).toBeGreaterThan(1);
  });
});
