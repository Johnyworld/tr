import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { createTestStore, loadRealContent, TEST_CONTENT } from "../testing.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { WorldManager } from "../world/manager.ts";
import type { StoryletEffect } from "../content/schemas.ts";
import { activeMissionOf } from "../game/missions.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { applyEffect } from "./storyletTools.ts";

/** 플레이 테스트 14 (docs/playtests/2026-11-22-mcp-14.md)의 임무·아이템·치료비 버그 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, seed = 5) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt14m-")), content, rngFactory: () => createSeededRng(seed) });
  return m.create("mcp", roleId, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("치료 값 (동무조 T27·T28)", () => {
  function atClinic() {
    const w = world("role_c_comrades");
    const ctx = w.ctx();
    const healer = Object.values(content.npcs).find((n) => n.healer && n.faction === "faction_d" && n.zone === "d_clinic")!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: "d_clinic" });
    const me = w.state().characters[w.state().playerId]!;
    me.conditions.harm = "light";
    me.inventory = { cigarettes: 0, potato: 1, ks_lighter: 1, trade_token: 1 };
    me.equipped = { weapon: null, body: null, head: null, arms: null, outer: null };
    w.state().scene.present.push(healer);
    return { w, healer };
  }

  it("고른 값이 모자라면 시간이 흐르지 않고, 무엇이 얼마나 모자란지 알린다", () => {
    const { w } = atClinic();
    const before = w.state().time;
    const out = w.executeTool("take_action", act({ intent: "치료를 받는다", treatment: { item: null, target: null, pay: [{ item: "potato", quantity: 1 }] } }));
    expect(out.ok).toBe(false);
    expect(w.state().time).toBe(before);
    const error = out.ok ? "" : out.error;
    expect(error).toContain("감자 ×1 = 1");
    expect(error).toContain("2 모자란다");
  });

  it("소중한 것(신표)은 값으로 낼 수 없다", () => {
    const { w } = atClinic();
    const before = w.state().time;
    for (const item of ["ks_lighter", "trade_token"]) {
      const out = w.executeTool("take_action", act({ intent: "치료를 받는다", treatment: { item: null, target: null, pay: [{ item, quantity: 1 }] } }));
      expect(out.ok).toBe(false);
      expect(out.ok ? "" : out.error).toContain("소중한 것");
    }
    expect(w.state().time).toBe(before);
  });

  it("값을 내면 낸 물건이 몇 어치인지 결과에 보인다", () => {
    const { w } = atClinic();
    w.state().characters[w.state().playerId]!.inventory.cigarettes = 1;
    const out = w.executeTool("take_action", act({ intent: "치료를 받는다", treatment: { item: null, target: null, pay: [{ item: "cigarettes", quantity: 1 }] } }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok && out.resultText).toMatch(/담배 ×1을 냈다 \(3어치/);
  });
});

describe("임무 판정과 맡은 짐 (방문자 T37)", () => {
  function errand(rng: () => number) {
    const c: Content = structuredClone(TEST_CONTENT);
    c.items.rope = { ...c.items.rope!, id: "rope" };
    c.missions.m_trade = {
      id: "m_trade", title: "밧줄 흥정", briefing: "초소에서 밧줄을 무전기와 바꾼다", giver_rank: "squad_leader", deadline_hours: 12, where: "a_post",
      carries: { rope: 2 }, collects: { radio: 1 }, requirements: [{ deliver: "rope", quantity: 2 }, { check: "persuade", min_outcome: "partial" }],
    };
    c.roles.role_test!.missions = ["m_trade"];
    const store = createTestStore();
    store.append({ type: "turn_started", turn: 1, input: "" });
    const ctx = { store, rng, content: c };
    runAfterTimeAdvance(ctx);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    expect(executeTool("assign_mission", { template_id: "m_trade" }, ctx).ok).toBe(true);
    executeTool("take_action", act({ intent: "초소로 간다", move_to: "a_post" }), ctx);
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, ctx);
    const talk = { move: "persuade", stat: "persuasion", difficulty: "normal", harm_on_failure: "none", harm_cause: "" };
    const out = executeTool("take_action", act({ intent: "흥정한다", for_mission: true, target: "npc_stranger", check: talk }), ctx);
    return { store, out };
  }

  it("흥정 판정이 빗나가면 짐을 넘기지 않는다", () => {
    const { store, out } = errand(() => 0);
    const text = out.ok ? out.resultText : out.error;
    expect(text).not.toContain("짐을 넘겼다");
    expect(store.getState().characters[store.getState().playerId]!.inventory.rope).toBe(2);
    expect(store.getState().characters.npc_stranger!.inventory.rope ?? 0).toBe(0);
  });

  it("흥정이 되면 짐은 상대에게 건너간다 (사라지지 않는다)", () => {
    const { store, out } = errand(() => 0.99);
    expect(out.ok && out.resultText).toContain("짐을 넘겼다");
    expect(store.getState().characters[store.getState().playerId]!.inventory.rope ?? 0).toBe(0);
    expect(store.getState().characters.npc_stranger!.inventory.rope).toBe(2);
  });
});

describe("무리를 옮기면 예전 무리의 임무 (방문자 T51~T63)", () => {
  function onErrand() {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const commander = content.roles.role_a_grunt!.commander!;
    w.state().scene.present.push(commander);
    w.state().missionGraceUntil = null;
    runMissionStartOfTurn(ctx);
    w.state().offers = { ...w.state().offers!, templateIds: ["market_errand"] };
    const got = w.executeTool("assign_mission", { template_id: "market_errand" });
    expect(got.ok, got.ok ? "" : got.error).toBe(true);
    return { w, ctx };
  }

  it("다른 무리에 들면 예전 임무는 거기서 끝나고, 새 무리의 공적·불복종에 들지 않는다", () => {
    const { w, ctx } = onErrand();
    const me = () => w.state().characters[w.state().playerId]!;
    const merit = me().merit;
    const out = applyEffect(ctx, { join_faction: { faction: "faction_c" } } as StoryletEffect, {}, {}, "테스트");
    expect(out.line).toContain("나루상단 장터 심부름");
    expect(activeMissionOf(w.state().missions, w.state().playerId)).toBeUndefined();
    expect(me().merit).toBe(merit);
    expect(me().disobedience).toBe(0);
    // 기한이 지나도 새 무리의 불복종으로 셈하지 않는다
    w.state().time += 2 * 1440;
    runMissionStartOfTurn(ctx);
    expect(me().disobedience).toBe(0);
    expect(me().merit).toBe(merit);
  });

  it("무리가 달라진 채 남은 임무(예전 세이브)는 턴 시작에 벌 없이 끝난다", () => {
    const { w, ctx } = onErrand();
    // 예전 코드로 무리를 옮겨 임무가 남은 세이브: 조건을 다 채워 기한이 지나도 끝나지 않던 임무
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    m.metAt = w.state().time;
    w.state().characters[w.state().playerId]!.factionId = "faction_c";
    w.state().time = m.deadline + 60;
    runMissionStartOfTurn(ctx);
    expect(activeMissionOf(w.state().missions, w.state().playerId)).toBeUndefined();
    expect(w.state().characters[w.state().playerId]!.disobedience).toBe(0);
  });
});
