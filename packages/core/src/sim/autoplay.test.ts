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
