import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { breakTruceIfAny, describeDiplomacyForGm } from "../engine/diplomacy.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
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

describe("지도부끼리 맺은 휴전을 주인공이 깬다 (12-147)", () => {
  it("휴전 중인 무리의 사람을 치면 두 무리가 서로 깊이 미워하고, 배신이 남고, 외교 줄에서 사라진다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-tb-")), content, rngFactory: () => createSeededRng(2) }).create("mcp", "role_a_officer");
    const s = w.state();
    s.factions.faction_a!.truces = { faction_c: { days: 10, restore: -2 } };
    s.factions.faction_c!.truces = { faction_a: { days: 10, restore: -2 } };
    s.factions.faction_a!.disposition = { ...s.factions.faction_a!.disposition, faction_c: -1 };
    s.factions.faction_c!.disposition = { ...s.factions.faction_c!.disposition, faction_a: -1 };
    expect(describeDiplomacyForGm(s, content)).toContain("지도부끼리 맺은 휴전");
    const victim = Object.values(content.npcs).find((n) => n.faction === "faction_c")!.id;
    expect(breakTruceIfAny(w.ctx(), victim)).toContain("휴전이 깨졌다");
    const after = w.state();
    expect(disposition(content, "faction_a", "faction_c", after)).toBe(-3);
    expect(disposition(content, "faction_c", "faction_a", after)).toBe(-3);
    expect(Object.values(after.deeds).some((d) => d.summary.includes("휴전 중에"))).toBe(true);
    expect(describeDiplomacyForGm(after, content)).not.toContain("지도부끼리 맺은 휴전");
    // 이미 깨졌으면 다시 깨지 않는다
    expect(breakTruceIfAny(w.ctx(), victim)).toBeNull();
  });
});

describe("피난민은 물도 있어야 든다 (12-147)", () => {
  it("식량은 넉넉해도 물이 두 주 치가 안 되면 사람이 들지 않는다", () => {
    const world = initialWarWorld(content);
    const b = world.factions.faction_b!;
    b.resources.food = 99999;
    b.resources.water = 0;
    const pop = b.population;
    let w = world;
    for (let i = 0; i < 30; i++) {
      const r = simulateWarDay(w, content, () => 0, {});
      w = { factions: r.factions, zones: r.zones, clocks: r.clocks };
      w.factions.faction_b!.resources.water = 0;
      w.factions.faction_b!.resources.food = 99999;
    }
    expect(w.factions.faction_b!.population).toBeLessThanOrEqual(pop);
    // 같은 조건에 물만 넉넉하면 사람이 든다
    let ok = initialWarWorld(content);
    for (let i = 0; i < 30; i++) {
      ok.factions.faction_b!.resources.water = 99999;
      ok.factions.faction_b!.resources.food = 99999;
      const r = simulateWarDay(ok, content, () => 0, {});
      ok = { factions: r.factions, zones: r.zones, clocks: r.clocks };
    }
    expect(ok.factions.faction_b!.population).toBeGreaterThan(pop);
  });
});

