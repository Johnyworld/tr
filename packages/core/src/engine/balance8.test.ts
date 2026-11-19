import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { formSquad, refugeeToSquad } from "./promotion.ts";
import { squadMembers } from "./command.ts";
import { feelsLike } from "./climate.ts";
import { createContentSchemas } from "../content/schemas.ts";

/** 긴 판(플레이 테스트 8)의 균형 손보기 (12-190) */
const real = loadRealContent();
const content = { ...real, storylets: {} };
const make = (role: string, roll: () => number, c = content) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bal8-")), content: c, rngFactory: () => roll }).create("mcp", role);
const act = (w: GameWorld, extra: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const promote = (w: GameWorld) => w.ctx().store.append({ type: "promoted", characterId: w.state().playerId, from: "grunt", to: "squad_leader" });

describe("진급과 분대 (12-190)", () => {
  it("비어 있는 분대가 있어도 대개(70%) 새 사람 1~3명으로 분대를 꾸린다", () => {
    const w = make("role_a_grunt", () => 0.1);
    promote(w);
    const lines = formSquad(w.ctx());
    const squad = squadMembers(w.state(), content);
    expect(squad.length).toBeGreaterThanOrEqual(1);
    expect(squad.length).toBeLessThanOrEqual(3);
    expect(squad.every((id) => id.startsWith("ex_") && w.state().characters[id]!.factionId === "faction_a")).toBe(true);
    expect(lines.join()).toContain("새 분대원");
  });

  it("나머지(30%)는 비어 있는 분대를 넘겨받는다. 원래 분대장의 분대는 그대로다", () => {
    const w = make("role_a_grunt", () => 0.99);
    promote(w);
    formSquad(w.ctx());
    const squad = squadMembers(w.state(), content);
    expect(squad).toEqual(expect.arrayContaining(real.roles.role_a_squad_leader!.squad!.filter((id) => !w.state().characters[id]!.dead)));
    expect(squad).not.toContain("a_jiho"); // 강태호 분대의 동료는 그대로 강태호 밑에
  });

  it("분대가 모자란 동안 피난민이 들면 확률로 한 명이 분대에 배치된다", () => {
    const w = make("role_a_grunt", () => 0.1);
    promote(w);
    formSquad(w.ctx());
    const before = squadMembers(w.state(), content).length;
    const line = refugeeToSquad(w.ctx());
    if (before < 4) {
      expect(line).toContain("분대에 배치됐다");
      expect(squadMembers(w.state(), content).length).toBe(before + 1);
    }
  });
});

describe("몸 (12-190)", () => {
  it("판정에서 이미 다쳤으면 이야기의 '다친다'는 겹쳐 붙지 않는다", () => {
    const parse = createContentSchemas(real.scenario).storylet.parse;
    const story = parse({
      id: "t_hurt",
      title: "테스트",
      tags: ["world"],
      when: {},
      cast: {},
      setup: "x",
      choices: [{ id: "go", label: "간다", check: "fight", outcomes: { success: [], partial: [], miss: [{ wound: { steps: 1, cause: "이야기의 상처" } }] } }],
    });
    const c = { ...real, storylets: { t_hurt: story } };
    const w = make("role_a_grunt", () => 0, c);
    expect(w.runCheat("~storylet t_hurt").ok).toBe(true);
    act(w, { check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "주먹", harm_kind: "blunt", infected_source: false, target_harm: "none", distance: "close" } });
    const after = w.state().characters[w.state().playerId]!.conditions.harm;
    expect(w.executeTool("resolve_storylet", { choice_id: "go" }).ok).toBe(true);
    expect(w.state().characters[w.state().playerId]!.conditions.harm).toBe(after);
  });

  it("주인공이 피를 흘리면 곁의 동료가 한 시간 안에 지혈한다", () => {
    const w = make("role_a_grunt", () => 0.5);
    expect(w.runCheat("~summon a_jiho").ok).toBe(true);
    expect(w.runCheat("~set bleeding bleeding").ok).toBe(true);
    act(w, { activity: { kind: "rest", until: null } });
    act(w, { activity: { kind: "rest", until: null } });
    expect(w.state().characters[w.state().playerId]!.conditions.bleeding).toBe("none");
  });

  it("난로는 땔감을 넣어야 타고, 모닥불보다 세 배 오래 탄다", () => {
    const w = make("role_l_wanderer", () => 0.99);
    const zone = w.state().playerZone!;
    w.ctx().store.append({ type: "home_settled", characterId: w.state().playerId, zone });
    w.ctx().store.append({ type: "facility_built", zone, facility: "stove" });
    expect(feelsLike(real, w.state(), "rest")!.parts.some((p) => p.startsWith("난로"))).toBe(false);
    const r = act(w, { use_item: "firewood" });
    expect(r.ok && r.resultText).toContain("난로에");
    expect((w.state().fires[zone] ?? 0) - w.state().time).toBeGreaterThan(20 * 60);
    expect(feelsLike(real, w.state(), "rest")!.parts.some((p) => p.startsWith("난로"))).toBe(true);
  });
});
