import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { neighbors } from "../sim/war.ts";
import { shelterAt } from "../rules/place.ts";
import { onSpottedAtHome } from "../rules/consequence.ts";
import { rollPlayerCheck } from "./checks.ts";
import { captureNpc } from "./captivity.ts";
import { memberTemplate } from "../game/startGroup.ts";

/** 플레이 테스트 15 (docs/playtests/2026-11-22-mcp-15.md) 확실한 버그 묶음 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, rng: () => () => number = () => createSeededRng(5)) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt15-")), content, rngFactory: rng });
  return m.create("mcp", roleId, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});
const check = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const statOf = (move: string) => content.scenario.moves.find((m) => m.id === move)!.stats[0]!;

describe("플레이 테스트 15", () => {
  it("구역을 옮길 때 with의 사람도 함께 간다 (3-1: 세 판에서 말없이 남겨졌다)", () => {
    const w = world("role_a_grunt");
    const mate = "a_jiho";
    const r0 = w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    expect(r0.ok, r0.ok ? "" : r0.error).toBe(true);
    const to = neighbors(content, w.state().playerZone!)[0]!;
    const r = w.executeTool("take_action", act({ move_to: to, with: [mate] }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (w.state().playerZone !== to) return; // 길 위의 일로 멈췄으면 볼 수 없다
    expect(w.state().scene.present).toContain(mate);
    expect(r.ok && r.resultText).toContain("함께 데려왔다");
  });

  it("은밀이 성공한 일은 장면의 사람도 보지 못한다 (4-2 졸병: 은밀 13 성공 도둑질을 모두가 보았다)", () => {
    const w = world("role_a_grunt", () => () => 0.99);
    const mate = "a_jiho";
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const move = content.scenario.move_roles.stealth;
    const deed = { summary: "몰래 통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "semi_private", noisy: false, condition: "always" };
    const r = w.executeTool("take_action", act({ check: check(move, statOf(move)), deed }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const d = Object.values(w.state().deeds).find((x) => x.summary === deed.summary)!;
    expect(d.witnesses.some((x) => x.npcId === mate)).toBe(false);
  });

  it("아무도 못 봤으면 '들켰다' 행적을 남기지 않는다 (4-2 졸병)", () => {
    const w = world("role_a_grunt", () => () => 0.99);
    const before = Object.keys(w.state().deeds).length;
    const lines = onSpottedAtHome(w.ctx());
    expect(lines.join(" ")).toContain("본 사람이 없는");
    expect(Object.keys(w.state().deeds).length).toBe(before);
  });

  it("구역을 옮기는 길은 바깥이다 (3-9: 빗속 45분을 걸어도 옷이 마른 채였다)", () => {
    const w = world("role_a_grunt");
    expect(shelterAt(content, w.state(), "travel").indoor).toBe(false);
  });

  it("마음의 굴림에는 곁의 사람이 돕지 않는다 (4-1 분대장: 자존심 거스르기에 '도움 +1')", () => {
    const w = world("role_a_grunt");
    const mate = "a_jiho";
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const steady = content.scenario.body!.steady!;
    const r = rollPlayerCheck({ move: steady.move, stat: steady.stat, difficulty: "normal", intent: "거스른다" }, w.ctx(), { reaction: true, purpose: "reaction", allies: [mate], stakes: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.display.line).not.toContain("도움");
  });

  it("부모는 젊어도 부모 틀이다 (4-4 튜토리얼: 53세 아버지가 형제자매 틀)", () => {
    const rules = content.scenario.custom_start!.group!;
    expect(memberTemplate(content, { relation: "parent", name: "황승우", age: 53, gender: "male" })).toBe(rules.templates.elder);
  });

  it("붙잡힌 인물은 무기를 빼앗긴다 (4-4 튜토리얼: 수용소 포로가 쇠지렛대를 지녔다)", () => {
    const w = world("role_a_grunt");
    const armed = Object.values(w.state().characters).find((c) => c.id !== w.state().playerId && !c.factionId?.startsWith("faction_a") && Object.keys(c.inventory).some((id) => !!content.items[id]?.weapon))!;
    expect(armed).toBeDefined();
    captureNpc(w.ctx(), armed.id, w.state().characters[w.state().playerId]!.factionId, w.state().playerZone!);
    expect(Object.keys(w.state().characters[armed.id]!.inventory).some((id) => !!content.items[id]?.weapon)).toBe(false);
  });

  it("직속 상관과 같은 분대는 처음부터 태도를 안다 (4-2 졸병: 분대장을 '만나 본 적 없다')", () => {
    const w = world("role_a_grunt");
    expect(w.state().perceived.a_taeho).toBeDefined();
    expect(w.state().perceived.a_jiho).toBeDefined();
  });
});
