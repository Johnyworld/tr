import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sagaState } from "../rules/saga.ts";
import { dayOf } from "../rules/time.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { autoplay } from "./autoplay.ts";

/**
 * 큰 이야기 「남쪽의 배」를 실제 콘텐츠로 끝까지 (docs/saga-plan.md 파트 10): 문이 열리고, 이야기와 시계로 막이 넘어가고,
 * 아무도 길을 고르지 않아도(자동 플레이는 무작위로 고른다) 결말에 닿는다. 주인공이 죽으면 계승자가 이어 간다
 */
describe("큰 이야기 자동 플레이 (실제 콘텐츠)", () => {
  it("「남쪽의 배」가 7일째쯤 열리고 오류 없이 결말에 닿는다", () => {
    const content = loadRealContent();
    const world = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-saga-")), content, rngFactory: () => createSeededRng(7) }).create("mcp", "role_a_grunt", {
      name: "서진",
      gender: "female",
      abilities: null,
      portrait: null,
      traits: [],
    } as never);
    const stats = autoplay(world, content, createSeededRng(70), 2500);
    const g = sagaState(world.state(), "south_ship");
    world.close();
    expect(stats.errors).toEqual([]);
    expect(g).not.toBeNull();
    expect(dayOf(g!.openedAt)).toBeLessThanOrEqual(9);
    expect(g!.act).toBe("ended");
    expect(["blocked", "handed"]).toContain(g!.ending);
    const fired = Object.keys(stats.storyletsFired).filter((id) => id.startsWith("sb"));
    // 시작 사건과 막마다의 이야기가 열린다 (시계로만 넘어가지 않는다)
    expect(fired.some((id) => id.startsWith("sb0_"))).toBe(true);
    expect(fired.length).toBeGreaterThanOrEqual(8);
  }, 600_000);
});
