import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helperFor, staunchHelper } from "../rules/company.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { healerFor } from "./care/kinds.ts";

/** 플레이 테스트 15 파트 4 (12-256): 싸움·치료 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-256-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const set = (w: ReturnType<typeof world>, who: string, track: string, to: string) =>
  w.ctx().store.append({ type: "condition_changed", targetId: who, track, from: w.state().characters[who]!.conditions[track]!, to, fatal: false, by: "cheat", cause: "테스트", day: 1, harmTrack: track === content.scenario.harm_track });

describe("곁의 사람 (12-256, 공통 규칙 8)", () => {
  it("맞서 싸우는 판정은 with로 함께 싸우는 사람이 스킬이 없어도 +1, 다른 판정은 스킬이 있어야 돕는다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const melee = content.scenario.gear!.attack_moves[0]!;
    const ally = Object.values(content.npcs).find((n) => n.zone === "a_base" && !(n.skills?.[melee]) && !n.healer)!.id;
    w.executeTool("npc_presence", { npc_id: ally, action: "enter" });
    const st = w.state();
    expect(s.scene.present).not.toContain(ally);
    expect(helperFor(st, content, melee, [ally])).toEqual({ id: ally, bonus: 1 });
    expect(helperFor(st, content, melee, [])).toBeNull();
    // 맞서 싸우는 판정이 아니면 스킬이 없는 사람은 돕지 않는다
    const talk = "persuade";
    if (!(content.npcs[ally]!.skills?.[talk])) expect(helperFor(st, content, talk, [ally])?.id).not.toBe(ally);
  });

  it("피 흘리는 주인공은 위협이 없으면 그 행동이 끝날 때 곁의 사람이 지혈한다", () => {
    const w = world("role_a_grunt");
    const me = w.state().playerId;
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_a" && n.zone === "a_base" && !n.healer)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const bleed = content.scenario.wounds!.track;
    const levels = content.scenario.condition_tracks.find((t) => t.id === bleed)!.levels;
    set(w, me, bleed, levels.at(-1)!.id);
    expect(staunchHelper(w.state(), content, me)).toEqual({ id: mate, blocked: false });
    expect(w.sceneForGm()).toContain("이번 행동이 끝날 때 지혈한다");
    const r = w.executeTool("take_action", act({ intent: "숨을 고른다" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().characters[me]!.conditions[bleed]).toBe(levels[0]!.id);
    expect(r.ok && r.resultText).toContain("지혈");
  });
});

describe("치료사 고르기 (12-256)", () => {
  it("수술감이면 장면의 치료사 가운데 수술할 줄 아는 사람을, GM이 고르면 그 사람을", () => {
    const w = world("role_a_grunt");
    const me = w.state().playerId;
    w.executeTool("npc_presence", { npc_id: "pa_narae", action: "enter" });
    w.executeTool("npc_presence", { npc_id: "a_chaewon", action: "enter" });
    const harm = content.scenario.harm_track;
    set(w, me, harm, content.scenario.recovery!.surgery!.from);
    expect(healerFor(w.ctx(), me)).toBe("a_chaewon");
    expect(healerFor(w.ctx(), me, "pa_narae")).toBe("pa_narae");
    expect(healerFor(w.ctx(), me, "a_taeho")).toBeNull();
  });
});

describe("맨손 (12-256)", () => {
  it("check.unarmed면 손에 든 무기의 보정 없이 맨손으로 친다", () => {
    const w = world("role_a_grunt");
    const me = w.state().playerId;
    const melee = content.scenario.gear!.unarmed.moves[0]!;
    const weapon = Object.entries(content.items).find(([, i]) => i.weapon?.moves.includes(melee) && (i.weapon?.bonus ?? 0) > 0 && !i.weapon?.ammo)![0];
    w.runCheat(`~give ${weapon} 1`);
    expect(w.executeTool("equip", { item_id: weapon }).ok).toBe(true);
    const foe = Object.values(content.npcs).find((n) => n.zone === "a_base" && !n.healer)!.id;
    w.executeTool("npc_presence", { npc_id: foe, action: "enter" });
    const check = { move: melee, stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", infected_source: false, target_harm: "light", distance: content.scenario.gear?.distances?.[0]?.id ?? null, opponent: foe };
    const armed = w.executeTool("take_action", act({ intent: "친다", target: foe, check }));
    expect(armed.ok, armed.ok ? "" : armed.error).toBe(true);
    expect(armed.ok && armed.resultText).toContain(content.items[weapon]!.name);
    const bare = w.executeTool("take_action", act({ intent: "주먹을 날린다", target: foe, check: { ...check, unarmed: true } }));
    expect(bare.ok, bare.ok ? "" : bare.error).toBe(true);
    const line = (bare.ok ? bare.resultText : "").split("\n").find((l) => l.startsWith("🎲")) ?? "";
    expect(line).not.toContain(content.items[weapon]!.name);
    expect(w.state().characters[me]!.equipped?.weapon).toBe(weapon);
  });
});
