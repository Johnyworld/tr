import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { knowsPlace, roadsIn } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 길과 담 문은 처음부터 알지 못한다: 구역에 들어서 선 길과 지나가 본 곳만 안다 (12-353) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

function loner() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-roads-")), content, rngFactory: () => createSeededRng(5) });
  return m.create("mcp", "role_t_visitor", choice);
}

describe("길은 지나 봐야 안다", () => {
  it("남의 땅 구역에서 서 있지 않은 다른 길은 모르고, 서 있는 길은 안다", () => {
    const w = loner();
    w.runCheat("~goto bus_depot");
    const s = w.state();
    const zone = s.playerZone!;
    const roads = roadsIn(s, content, zone);
    expect(roads.length).toBeGreaterThan(1);
    expect(knowsPlace(s, content, zone, s.playerPlace)).toBe(true);
    for (const r of roads.filter((x) => x.id !== s.playerPlace)) expect(knowsPlace(s, content, zone, r.id), r.id).toBe(false);
  });

  it("지나간 길은 떠나도 계속 안다", () => {
    const w = loner();
    w.runCheat("~goto bus_depot");
    const zone = w.state().playerZone!;
    const first = w.state().playerPlace!;
    const other = roadsIn(w.state(), content, zone).find((r) => r.id !== first)!;
    w.ctx().store.append({ type: "place_moved", from: first, to: other.id });
    w.ctx().store.append({ type: "place_moved", from: other.id, to: first });
    expect(knowsPlace(w.state(), content, zone, other.id)).toBe(true);
  });

  it("처음 가는 구역의 길을 모르면 거절 글이 그 길의 이름도 id도 알리지 않는다", () => {
    const w = loner();
    w.runCheat("~goto bus_depot");
    const s = w.state();
    const zone = s.playerZone!;
    const target = content.locations[zone]!.adjacent.find((z) => !(s.visited[s.playerId] ?? []).includes(z) && roadsIn(s, content, zone).some((r) => r.to.includes(z) && r.id !== s.playerPlace));
    if (!target) return;
    const road = roadsIn(s, content, zone).find((r) => r.to.includes(target))!;
    const r = w.executeTool("take_action", act({ move_to: target }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("어디인지 아직 모른다");
      expect(r.error).not.toContain(road.id);
      expect(r.error).not.toContain(road.name);
    }
  });
});
