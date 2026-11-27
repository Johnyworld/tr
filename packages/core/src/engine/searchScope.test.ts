import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBringLoot } from "../content/bringLoot.ts";
import { createSeededRng } from "../rng.ts";
import { searchSpot } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { createTakeActionSchema, takeAction } from "./action.ts";
import { scopeFinds, searchScopeOf, searchedToday } from "./scavenge.ts";

/** 수색 범위·시간·다침 (12-355, 사용자 결정) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-search-")), content, rngFactory: () => createSeededRng(3) });
  const w = m.create("mcp", "role_t_visitor", choice);
  w.runCheat("~goto bus_depot");
  return w;
}

const search = (scope: string | null, check: Record<string, unknown> | null = null) => ({
  intent: "뒤진다", check, activity: { kind: "search", until: null, hours: null, scope }, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true,
});
const scavengeCheck = (harm: "none" | "light" | "heavy") => ({ move: "scavenge", stat: "senses", difficulty: "normal", harm_on_failure: harm, harm_cause: "깨진 유리", harm_kind: "cut" });
const schema = createTakeActionSchema(content.scenario);
const parse = (input: unknown) => schema.parse(input);

describe("수색 범위", () => {
  it("방 하나는 15분, 건물 한 층은 60분이 든다 (판정 없이 둘러보기)", () => {
    const w = world();
    const t0 = w.state().time;
    expect(w.executeTool("take_action", search("room")).ok).toBe(true);
    expect(w.state().time - t0).toBe(15);
    const t1 = w.state().time;
    expect(w.executeTool("take_action", search("floor")).ok).toBe(true);
    expect(w.state().time - t1).toBe(60);
  });

  it("범위를 고르지 않으면 방 하나다", () => {
    const w = world();
    const t0 = w.state().time;
    expect(w.executeTool("take_action", search(null)).ok).toBe(true);
    expect(w.state().time - t0).toBe(15);
  });

  it("찾는 수는 범위 안에서 굴리고, 대가 있는 성공은 최소 1, 실패는 0", () => {
    const room = searchScopeOf(content, "room")!;
    const floor = searchScopeOf(content, "floor")!;
    for (const r of [0, 0.5, 0.999]) {
      const rng = () => r;
      expect(scopeFinds(room, "success", rng)).toBeGreaterThanOrEqual(1);
      expect(scopeFinds(room, "success", rng)).toBeLessThanOrEqual(3);
      expect(scopeFinds(room, "partial", rng)).toBe(1);
      expect(scopeFinds(floor, "success", rng)).toBeGreaterThanOrEqual(2);
      expect(scopeFinds(floor, "success", rng)).toBeLessThanOrEqual(5);
      expect(scopeFinds(floor, "partial", rng)).toBeGreaterThanOrEqual(1);
      expect(scopeFinds(floor, "partial", rng)).toBeLessThanOrEqual(2);
      expect(scopeFinds(floor, "miss", rng)).toBe(0);
    }
  });

  it("같은 날 다시 뒤지는 보정은 뒤진 시간으로 센다: 방 하나 1, 건물 한 층 4", () => {
    const w = world();
    const spot = () => searchSpot(w.state()) ?? w.state().playerZone!;
    w.executeTool("take_action", search("room"));
    expect(searchedToday(w.state(), spot())).toBe(1);
    w.executeTool("take_action", search("floor"));
    expect(searchedToday(w.state(), spot())).toBe(5);
  });
});

describe("수색의 다침", () => {
  it("무거운 위험은 가벼운 위험으로 세고, 그날 그 자리에서 한 번 다치면 다시 다치지 않는다", () => {
    const w = world();
    const miss = { ...w.ctx(), rng: () => 0 }; // 주사위 1+1: 실패
    const first = takeAction(parse(search("room", scavengeCheck("heavy"))), miss);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.resultText).toContain("가벼운 위험까지");
      expect(first.resultText).toContain("찾지 못했다");
      expect(first.resultText).toContain("지어내지 않는다");
    }
    const spot = searchSpot(w.state()) ?? w.state().playerZone!;
    expect(w.state().zoneSearches[spot]?.hurt).toBe(true);
    const harmBefore = w.state().characters[w.state().playerId]!.conditions.harm;
    const second = takeAction(parse(search("room", scavengeCheck("light"))), { ...w.ctx(), rng: () => 0 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.resultText).toContain("이미 한 번 다쳐");
    expect(w.state().characters[w.state().playerId]!.conditions.harm).toBe(harmBefore);
  });
});

describe("구해 오는 임무 검사 (content:check)", () => {
  it("지금 월드의 구해 오는 임무는 모두 그 자리의 찾을 거리 표에 자원이 있다", () => {
    expect(checkBringLoot(content)).toEqual([]);
  });

  it("표에 없는 자원을 구해 오게 하면 잡아낸다", () => {
    const m = Object.values(content.missions).find((x) => typeof x.where === "string" && x.requirements.some((r) => "bring" in r))!;
    const broken = { ...content, missions: { ...content.missions, [m.id]: { ...m, requirements: [{ bring: "no_such_resource", quantity: 1 }] } } };
    expect(checkBringLoot(broken as typeof content).join("\n")).toContain(m.id);
  });
});
