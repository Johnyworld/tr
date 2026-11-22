import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MissionInstance } from "../game/missions.ts";
import { graceExcuse } from "../rules/blame.ts";
import { searchSpot } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { issueArmory } from "./armory.ts";
import { scavengeParts } from "./scavenge.ts";

/** 플레이 테스트 15 파트 6 (12-258): 임무·성과 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string, roll = 0.5) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-258-")), content, rngFactory: () => () => roll }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const mission = (over: Partial<MissionInstance>): MissionInstance => ({ id: "m_t", templateId: "y_supply_boat", title: "t", briefing: "", giverId: "x", assigneeId: "player", status: "active", assignedAt: 0, deadline: 99999, requirements: [], progress: [], ...over }) as MissionInstance;

describe("무기고 (12-258)", () => {
  it("작살총만 지녔으면 소총도 함께 빌려준다 (작살총에 소총탄은 쓸모없다)", () => {
    const w = world("role_y_islander");
    const me = w.state().playerId;
    for (const item of ["old_rifle", "rifle_rounds"]) {
      const n = w.state().characters[me]!.inventory[item] ?? 0;
      if (n) w.executeTool("transfer_item", { from: me, to: "scene", item_id: item, quantity: n });
    }
    expect(w.state().characters[me]!.inventory.harpoon_gun).toBeGreaterThan(0);
    const line = issueArmory(w.ctx(), mission({ assigneeId: me }));
    expect(line).toContain(content.items.old_rifle!.name);
    expect(line).toContain(content.items.rifle_rounds!.name);
  });
});

describe("다시 뒤짐은 장소마다 (12-258)", () => {
  it("한 장소를 뒤진 뒤 다른 장소에서는 '오늘 다시 뒤짐'이 붙지 않는다", () => {
    const w = world("role_a_grunt");
    w.executeTool("take_action", act({ place_to: "storehouse" }));
    w.ctx().store.append({ type: "zone_searched", zone: searchSpot(w.state())!, day: Math.floor(w.state().time / 1440) + 1 });
    expect(scavengeParts(w.ctx()).some((p) => p.label === "오늘 다시 뒤짐")).toBe(true);
    w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(scavengeParts(w.ctx()).some((p) => p.label === "오늘 다시 뒤짐")).toBe(false);
  });
});

describe("대가 있는 성공의 대가 (12-258)", () => {
  it("같은 날 두 번째 '일이 꼬여 30분'은 시간 대신 소리가 난다", () => {
    const w = world("role_a_grunt");
    const check = { move: "sense_danger", stat: "senses", difficulty: "normal", harm_on_failure: "light", harm_cause: "삐끗", harm_kind: "blunt", infected_source: false, target_harm: "none" };
    const first = w.executeTool("take_action", act({ intent: "주위를 살핀다", check }));
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    const partial = (r: typeof first) => r.ok && r.resultText.includes("대가 있는 성공");
    expect(partial(first)).toBe(true);
    expect(first.ok && first.resultText).toContain("일이 꼬여");
    const second = w.executeTool("take_action", act({ intent: "다시 살핀다", check }));
    expect(partial(second)).toBe(true);
    expect(second.ok && second.resultText).toContain("소리를 냈다");
    expect(w.state().zoneNoise[w.state().playerZone!]?.level ?? 0).toBeGreaterThan(0);
  });
});

describe("적응 기간 (12-258, 공통 규칙 2)", () => {
  it("적응 기간에 받은 임무는 탓하지 않는다", () => {
    const w = world("role_a_grunt");
    const s = { ...w.state(), missionGraceUntil: w.state().time + 1440 };
    expect(graceExcuse(s, mission({ assignedAt: w.state().time }))?.cause).toBe("grace");
    expect(graceExcuse(s, mission({ assignedAt: w.state().time + 2000 }))).toBeNull();
    expect(graceExcuse(w.state(), mission({ assignedAt: w.state().time }))).toBeNull();
  });
});
