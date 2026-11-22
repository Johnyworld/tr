import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HURT_RESENTMENT } from "../rules/damage.ts";
import { ownOffense } from "../rules/consequence.ts";
import { heldOf } from "../rules/held.ts";
import { conditionsMet } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { PROMOTION } from "../game/missions.ts";

/** 플레이 테스트 15 파트 5 (12-257): 무리 안의 벌·관계 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string, roll = 0.5) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-257-")), content, rngFactory: () => () => roll }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const rel = (w: ReturnType<typeof world>, from: string) => w.state().relations[from]?.[w.state().playerId] ?? { trust: 0, affection: 0, respect: 0 };
const mateOf = (w: ReturnType<typeof world>) => Object.values(content.npcs).find((n) => n.faction === w.state().characters[w.state().playerId]!.factionId && n.zone === w.state().playerZone && !n.healer && n.id !== content.roles[w.state().roleId]?.commander)!.id;

describe("다치게 한 사람의 마음 (12-257, 공통 규칙 13)", () => {
  it("주인공이 다치게 하면 맞은 사람의 호감·신뢰가 단계마다 내려간다", () => {
    const w = world("role_a_grunt", 0.999);
    const foe = mateOf(w);
    w.executeTool("npc_presence", { npc_id: foe, action: "enter" });
    const before = rel(w, foe);
    const check = { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", infected_source: false, target_harm: "light", distance: "close", opponent: foe, unarmed: true };
    const r = w.executeTool("take_action", act({ intent: "주먹을 날린다", target: foe, check }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("원망한다");
    expect(rel(w, foe).affection).toBe(Math.max(-10, before.affection + HURT_RESENTMENT.affection));
    expect(rel(w, foe).trust).toBe(Math.max(-10, before.trust + HURT_RESENTMENT.trust));
  });
});

describe("원할 때의 선물 (12-257)", () => {
  it("배고픈 사람에게 먹을 것을 주면 호감 +1, 같은 날 두 번째는 그대로, 원하지 않는 것은 그대로", () => {
    const w = world("role_a_grunt");
    const mate = mateOf(w);
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const hunger = content.scenario.body!.hunger!.track;
    const levels = content.scenario.condition_tracks.find((t) => t.id === hunger)!.levels;
    w.ctx().store.append({ type: "condition_changed", targetId: mate, track: hunger, from: levels[0]!.id, to: levels[1]!.id, fatal: false, by: "cheat", cause: "테스트", day: 1, harmTrack: false });
    const food = Object.entries(content.scenario.consumables).find(([, e]) => (e[hunger] ?? 0) > 0)![0];
    w.runCheat(`~give ${food} 3`);
    const before = rel(w, mate).affection;
    const r = w.executeTool("transfer_item", { from: w.state().playerId, to: mate, item_id: food, quantity: 1 });
    expect(r.ok && r.resultText).toContain("반긴다");
    expect(rel(w, mate).affection).toBe(before + 1);
    w.executeTool("transfer_item", { from: w.state().playerId, to: mate, item_id: food, quantity: 1 });
    expect(rel(w, mate).affection).toBe(before + 1);
  });
});

describe("규율 회의 (12-257, 공통 규칙 3)", () => {
  it("우리 무리 사람이 본 도둑질은 규율 회의를 열게 하고, 받아들이면 벌을 받는다. 회의가 열린 뒤에는 다뤄진 것이다", () => {
    const w = world("role_c_raider");
    const mate = mateOf(w);
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    expect(ownOffense(w.state(), content)).toBeNull();
    const r = w.executeTool("take_action", act({ intent: "창고에서 통조림을 슬쩍한다", deed: { summary: "무리 창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "semi_private", noisy: false, condition: "always" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(ownOffense(w.state(), content)).not.toBeNull();
    expect(conditionsMet(w.state(), content, content.storylets.disc_c_council!, w.state().time)).toBe(true);
    expect(conditionsMet(w.state(), content, content.storylets.disc_a_council!, w.state().time)).toBe(false);
    w.runCheat("~storylet disc_c_council");
    expect(ownOffense(w.state(), content)).toBeNull();
    const res = w.executeTool("resolve_storylet", { choice_id: "accept" });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    const held = heldOf(w.state().characters[w.state().playerId]);
    expect(held?.by).toBe("faction_c");
    expect(held?.releaseAt).toBe(w.state().time + 1440);
    // 날수가 차면 저절로 풀린다
    for (let i = 0; i < 6 && heldOf(w.state().characters[w.state().playerId]); i++) w.executeTool("take_action", act({ activity: { kind: "wait", until: null, hours: 6 } }));
    expect(heldOf(w.state().characters[w.state().playerId])).toBeNull();
  });
});

describe("이미 정한 것과 문구 (12-257)", () => {
  it("진급의 상관 신뢰 문턱은 관계 범위에 맞춰 6", () => {
    expect(PROMOTION.minCommanderTrust).toBe(6);
  });

  it("분대 보고는 얼굴을 본 것이다: 보고로 바뀐 마음이 ?인물에도 보인다", () => {
    const w = world("role_a_squad_leader");
    const mate = mateOf(w);
    w.ctx().store.append({ type: "relation_changed", from: mate, to: w.state().playerId, delta: { trust: -1, affection: 0, respect: 0 }, reason: "테스트" });
    expect(w.state().perceived[mate]?.trust).not.toBe(rel(w, mate).trust);
    w.ctx().store.append({ type: "squad_order_done", npcId: mate, task: "x", outcome: "miss", report: "틀어졌다" });
    expect(w.state().perceived[mate]?.trust).toBe(rel(w, mate).trust);
  });
});
