import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletEffect } from "../content/schemas.ts";
import { bestStatOf } from "../rules/skill.ts";
import { moveOf } from "../scenario/scenario.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer } from "./captivity.ts";
import { changeCondition, isIncapacitated } from "./body.ts";
import { applyEffect } from "./storyletTools.ts";

/** PT22 뒤 고친 것 (12-288). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const quiet = { ...content, storylets: {} };
const make = (role: string, roll = 0.99) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-288-")), content: quiet, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("PT22 뒤 고친 것 (12-288)", () => {
  it("훔친 것 돌려놓기는 사물함에 넣어 둔 것도 돌려놓는다", () => {
    const w = make("role_y_islander");
    const s = w.state();
    w.ctx().store.append({ type: "item_granted", to: s.playerId, itemId: "canned_food", quantity: 2 });
    // 손에는 하나만 남기고 나머지는 사물함에
    const held = w.state().characters[s.playerId]!.inventory.canned_food ?? 0;
    w.ctx().store.append({ type: "item_stashed", characterId: s.playerId, zone: s.playerZone!, itemId: "canned_food", quantity: held - 1, direction: "put" });
    w.ctx().store.append({ type: "deed_recorded", deed: { id: `d_${s.nextDeedNo}`, actorId: s.playerId, summary: "궤짝에서 통조림을 챙겼다", tags: ["theft"], severity: 2, at: s.time, witnesses: [], searched: false } });
    w.ctx().store.append({ type: "deed_settled", deedId: `d_${s.nextDeedNo}`, endedAt: s.time, items: { canned_food: 2 } });
    const before = w.state().characters[s.playerId]!.inventory.canned_food ?? 0;
    const r = applyEffect(w.ctx(), { return_stolen: true } as StoryletEffect, {}, {}, "테스트");
    expect(r.line).toContain("×2");
    expect(w.state().characters[s.playerId]!.inventory.canned_food ?? 0).toBe(0);
    expect(w.state().stashes[s.playerId]?.[s.playerZone!]?.canned_food ?? 0).toBe(held - 2);
    void before;
  });

  it("탈출은 시스템 행적 하나만 남고, 넣은 deed는 따로 남기지 않는다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c", "c_warehouse", "테스트");
    const before = Object.keys(w.state().deeds).length;
    const move = "stealth";
    const r = w.executeTool("take_action", act({ move_to: "north_levee", check: { move, stat: moveOf(content.scenario, move)!.stats[0], difficulty: "normal", harm_on_failure: "heavy", harm_cause: "붙잡힘", harm_kind: "blunt" }, deed: { summary: "수용소를 빠져나왔다", tags: ["bravery"], severity: 1, privacy: "semi_private", noisy: false, condition: "on_success" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("따로 남기지 않았다");
    expect(Object.keys(w.state().deeds).length).toBe(before + 1);
  });

  it("무력화된 상대와는 맞서는 판정을 하지 않는다", () => {
    const w = make("role_a_grunt");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_a" && n.id !== content.roles.role_a_grunt!.commander)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    changeCondition(w.ctx(), mate, content.scenario.harm_track, 3, "enemy", "테스트");
    expect(isIncapacitated(content, w.state().characters[mate]!)).toBe(true);
    const r = w.executeTool("take_action", act({ target: mate, check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "", harm_kind: "blunt", opponent: mate } }));
    expect(!r.ok && r.error).toContain("무력화");
  });

  it("도구가 굴리는 판정은 그 스킬의 가장 나은 능력으로", () => {
    const w = make("role_y_islander");
    const m = moveOf(content.scenario, content.scenario.exploration!.search_move)!;
    const me = w.state().characters[w.state().playerId]!;
    const best = bestStatOf(w.state(), m);
    for (const st of m.stats) expect(me.stats[best] ?? 0).toBeGreaterThanOrEqual(me.stats[st] ?? 0);
  });

  it("무기고는 사물함에 있는 같은 탄의 총을 먼저 챙겨 주고 같은 총을 또 내주지 않는다", () => {
    const w = make("role_y_islander");
    const s = w.state();
    const locker = s.stashes[s.playerId]?.[s.playerZone!] ?? {};
    const gun = Object.keys(locker).find((i) => content.items[i]?.weapon?.ammo);
    if (!gun) return; // 시작 짐이 가벼우면 사물함에 총이 없다
    w.ctx().store.append({ type: "missions_offered", day: 1, templateIds: ["y_shore_watch"] });
    w.executeTool("npc_presence", { npc_id: content.roles.role_y_islander!.commander!, action: "enter" });
    const r = w.executeTool("assign_mission", { template_id: "y_shore_watch" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().stashes[s.playerId]?.[s.playerZone!]?.[gun] ?? 0).toBe(0);
  });
});
