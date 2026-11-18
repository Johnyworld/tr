import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseInfestation } from "../game/infestation.ts";
import { createSeededRng } from "../rng.ts";
import { castCandidates, conditionsMet } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { dayOf } from "../rules/time.ts";
import { initialWarWorld, warShareOf } from "./war.ts";

/** 전쟁에 돌리는 몫과 감염체 압력 (12-144) */
const content = loadRealContent();

describe("전쟁에 돌리는 몫", () => {
  it("자기 땅에 감염체가 몰린 만큼 줄고, 바닥 아래로는 내려가지 않는다", () => {
    const world = initialWarWorld(content);
    const base = content.factions.faction_c!.war_share ?? 1;
    expect(warShareOf(content, world, "faction_c", {})).toBeCloseTo(base);
    const cZone = Object.values(content.locations).find((l) => world.zones[l.id]?.owner === "faction_c")!.id;
    const over = (n: number) => ({ [cZone]: Math.min(3, baseInfestation(content, cZone) + n) });
    expect(warShareOf(content, world, "faction_c", over(1))).toBeLessThan(base);
    // 아무리 넘쳐도 바닥(기본 몫의 40%) 아래로는 내려가지 않는다
    const all = Object.fromEntries(Object.keys(content.locations).map((z) => [z, 3]));
    world.zones = Object.fromEntries(Object.entries(world.zones).map(([z, v]) => [z, { ...v, owner: "faction_c" }]));
    expect(warShareOf(content, world, "faction_c", all)).toBeCloseTo(base * content.scenario.infestation!.war_share_floor!);
  });

  it("남의 땅에서 소음을 크게 내면 그 땅의 순찰이 소리를 쫓아온다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ws-")), content, rngFactory: () => createSeededRng(2) }).create("mcp", "role_a_grunt");
    const s = w.state();
    const story = content.storylets.wg_noise_patrol!;
    const cZone = Object.values(content.locations).find((l) => s.zones[l.id]?.owner === "faction_c")!.id;
    s.playerZone = cZone;
    const day = dayOf(s.time);
    expect(conditionsMet(s, content, story, s.time)).toBe(false);
    s.zoneNoise[cZone] = { day, level: 2 };
    expect(conditionsMet(s, content, story, s.time)).toBe(true);
    expect(castCandidates(s, content, story.cast.patrol!).every((id) => s.characters[id]!.factionId === "faction_c")).toBe(true);
  });
});
