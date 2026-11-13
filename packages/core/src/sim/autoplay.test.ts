import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { autoplay } from "./autoplay.ts";

const REAL = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc");

/** 실제 콘텐츠로 무작위 플레이를 돌려 막히는 곳이 없는지 본다 (기획서 17) */
describe("랜덤 자동 플레이 (실제 콘텐츠)", () => {
  it("수백 턴 동안 오류 없이 돌고, 이야기가 열리고, 죽으면 다음 캐릭터로 이어진다", () => {
    const content = loadContent(REAL);
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(7) });
    const world = m.create("mcp");
    const stats = autoplay(world, content, createSeededRng(70), 400);
    world.close();
    expect(stats.errors).toEqual([]);
    expect(stats.days).toBeGreaterThan(10);
    expect(Object.keys(stats.storyletsFired).length).toBeGreaterThanOrEqual(8);
    expect(stats.zonesVisited.size).toBeGreaterThanOrEqual(6);
    expect(stats.successions).toBe(stats.deaths);
  });
});

/** 시작 시나리오마다 (새로 더한 콘텐츠 포함) 무작위 플레이가 막히지 않는지, 그 시나리오의 이야기가 열리는지 */
describe("시나리오마다 자동 플레이 (실제 콘텐츠)", () => {
  const content = loadContent(REAL);
  for (const role of Object.values(content.roles)) {
    it(`${role.id}: 오류 없이 돌고, 그 시나리오의 이야기가 열린다`, () => {
      const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(11) });
      const world = m.create("mcp", role.id);
      expect(world.state().playerZone).toBe(role.start_location ?? world.state().playerZone);
      const stats = autoplay(world, content, createSeededRng(110), 250);
      world.close();
      expect(stats.errors).toEqual([]);
      // 분대를 맡으면 분대 명령을, 회의에 앉으면 안을 올린다 (기획서 9.11)
      if (role.squad?.length) expect(stats.squadOrders).toBeGreaterThan(0);
      if (content.scenario.command?.council_ranks.includes(role.rank)) expect(stats.councilProposals).toBeGreaterThan(0);
      const own = Object.keys(stats.storyletsFired).filter((id) => content.storylets[id]?.tags.some((t) => role.storylet_tags.includes(t)));
      expect(own.length, `열린 이야기: ${Object.keys(stats.storyletsFired).join(", ")}`).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("무소속 자유 시나리오 자동 플레이 (실제 콘텐츠)", () => {
  it("오류 없이 돌고, 무소속의 이야기가 열리고, 어느 판에선 무리에 들어간다", async () => {
    const { buildCustomRole } = await import("../game/customStart.ts");
    const content = loadContent(REAL);
    const lonerTales = Object.values(content.storylets).filter((s) => s.when.factions?.includes("none")).map((s) => s.id);
    const fired = new Set<string>();
    let joined = 0;
    for (const seed of [1, 2, 3, 4]) {
      const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(seed) });
      const role = buildCustomRole(content, {
        faction: null, rank: "loner", title: "떠돌이", location: "old_town", kit: "wanderer", skills: { scavenge: 1, survival: 1 }, age: 30, opening: "폐허에서 눈을 뜬다.", background: [],
      });
      const world = m.create("mcp", undefined, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, undefined, { role, background: [] });
      const stats = autoplay(world, content, createSeededRng(seed * 7), 250);
      if (world.state().customRole?.faction) joined += 1;
      world.close();
      expect(stats.errors).toEqual([]);
      for (const id of Object.keys(stats.storyletsFired)) if (lonerTales.includes(id)) fired.add(id);
    }
    expect(fired.size).toBeGreaterThanOrEqual(3);
    expect(joined).toBeGreaterThanOrEqual(1);
  });
});

describe("연고와 함께 다니는 떠돌이 자동 플레이 (기획서 7.9)", () => {
  it("오류 없이 돌고, 떨어졌다가 다시 합류한다", async () => {
    const { buildCustomRole } = await import("../game/customStart.ts");
    const content = loadContent(REAL);
    let parted = 0;
    let rejoined = 0;
    for (const [seed, kin] of [[1, "kin_young"], [2, "kin_elder"], [3, "kin_sibling"], [4, "kin_partner"]] as const) {
      const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(seed) });
      const role = buildCustomRole(content, {
        faction: null, rank: "loner", title: "떠돌이", location: "old_town", kit: "wanderer", skills: { scavenge: 1 }, age: 30, opening: "폐허에서 눈을 뜬다.", background: [], kin: { template: kin, label: "가족" },
      });
      const world = m.create("mcp", undefined, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, undefined, { role, background: [] });
      const stats = autoplay(world, content, createSeededRng(seed * 7), 250);
      for (const e of world.ctx().store.events()) {
        if (e.type === "companion_parted") parted++;
        if (e.type === "companion_rejoined") rejoined++;
      }
      world.close();
      expect(stats.errors).toEqual([]);
    }
    expect(parted).toBeGreaterThan(0);
    expect(rejoined).toBeGreaterThan(0);
  });
});
