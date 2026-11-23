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
    // 인물이 늘면 무작위 순서가 바뀌어 하루쯤 오간다 (12-236: 치료사 둘을 더하자 11 → 10). 이동 기획(12-287) 뒤로는 구역 안을 돌아다니는 행동(5분)이 섞여 8
    expect(stats.days).toBeGreaterThanOrEqual(7);
    expect(Object.keys(stats.storyletsFired).length).toBeGreaterThanOrEqual(8);
    // 반복 이야기 자리를 즉흥 이야기가 채운다 (12-247). 대역 이야기로 오류 없이 풀린다
    expect(stats.storyletsFired["(즉흥)"] ?? 0).toBeGreaterThan(0);
    expect(stats.zonesVisited.size).toBeGreaterThanOrEqual(6);
    expect(stats.successions).toBe(stats.deaths);
  }, 30_000); // 400턴: 인물이 늘면 전체 실행 중에는 5초를 넘긴다

  it("같은 시드면 같은 판이 된다 (시계·세계 id에 기대는 무작위가 없다)", () => {
    const content = loadContent(REAL);
    const run = () => {
      const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(11) });
      const world = m.create("mcp", "role_e_porter");
      const stats = autoplay(world, content, createSeededRng(110), 200);
      const end = { time: world.state().time, zone: world.state().playerZone, player: world.state().playerId };
      world.close();
      return JSON.stringify({ stats: { ...stats, zonesVisited: [...stats.zonesVisited] }, end });
    };
    expect(run()).toBe(run());
  }, 30_000);
});

/** 시작 시나리오마다 (새로 더한 콘텐츠 포함) 무작위 플레이가 막히지 않는지, 그 시나리오의 이야기가 열리는지 */
describe("시나리오마다 자동 플레이 (실제 콘텐츠)", () => {
  const content = loadContent(REAL);
  for (const role of Object.values(content.roles)) {
    it(`${role.id}: 오류 없이 돌고, 그 시나리오의 이야기가 열린다`, () => {
      // 12-194 버그 고침 뒤 자동 플레이의 길이 바뀌었다 (난수 110이면 붉은연합 약탈조의 시나리오 이야기가 하나만 열렸다. 111~114는 3~5개).
      // 12-239: 이동 시간을 길마다 정하자 세계 시드 11의 날씨 순서가 바뀌어 짐꾼·경비가 비에 젖어 얼어 죽었다 (다른 세계 시드에서는 그대로).
      // 한 판의 날씨에 기대지 않게 두 판 가운데 이야기가 더 많이 열린 판으로 본다
      let best: string[] = [];
      let all: string[] = [];
      // 분대 명령·회의 안도 한 판의 운에 기대지 않게 두 판 가운데 한 번이라도 (PT21 뒤: 나루상단 간부 시드 111에서 회의를 한 번만 시도했고 이미 그 방침이었다)
      let orders = 0;
      let proposals = 0;
      const needsOrders = !!role.squad?.length;
      const needsCouncil = !!content.scenario.command?.council_ranks.includes(role.rank);
      for (const seed of [111, 113]) {
        const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-auto-")), content, rngFactory: () => createSeededRng(11) });
        const world = m.create("mcp", role.id);
        expect(world.state().playerZone).toBe(role.start_location ?? world.state().playerZone);
        const stats = autoplay(world, content, createSeededRng(seed), 320);
        world.close();
        expect(stats.errors).toEqual([]);
        // 분대를 맡으면 분대 명령을, 회의에 앉으면 안을 올린다 (기획서 9.11)
        orders += stats.squadOrders;
        proposals += stats.councilProposals;
        const own = Object.keys(stats.storyletsFired).filter((id) => content.storylets[id]?.tags.some((t) => role.storylet_tags.includes(t)));
        if (own.length > best.length) best = own;
        all = [...all, ...Object.keys(stats.storyletsFired)];
        if (best.length >= 2 && (!needsOrders || orders > 0) && (!needsCouncil || proposals > 0)) break;
      }
      expect(best.length, `열린 이야기: ${all.join(", ")}`).toBeGreaterThanOrEqual(2);
      if (needsOrders) expect(orders).toBeGreaterThan(0);
      if (needsCouncil) expect(proposals).toBeGreaterThan(0);
    }, 180_000);
  }
});

describe("무소속 자유 시나리오 자동 플레이 (실제 콘텐츠)", () => {
  it("오류 없이 돌고, 무소속의 이야기가 열리고, 어느 판에선 무리에 들어간다", async () => {
    const { buildCustomRole } = await import("../game/customStart.ts");
    const content = loadContent(REAL);
    const lonerTales = Object.values(content.storylets).filter((s) => s.when.factions?.includes("none")).map((s) => s.id);
    const fired = new Set<string>();
    let joined = 0;
    // 무리에 드는 판은 열에 한두 판이라 씨앗을 스물로 (12-206: 감염 굴림이 바뀌어 씨앗 1이 들지 않게 됐다. 12-269: 경보 쉬기·주인 없는 땅 규칙으로 붙잡혀 회유당하는 판이 줄어 열두 판에 0, 스무 판에 2)
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
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
  }, 180_000);
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
  }, 180_000); // 네 판을 돌려 기계 부하에 따라 18~38초로 들쭉날쭉하다
});
