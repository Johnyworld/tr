import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import { entrusted } from "../rules/entrusted.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 균형 F (플레이 테스트 11): 배달 일감의 짐과 받아 올 값(12-237), 물건으로 빚 갚기 */
function setup(edit: (c: Content) => void = () => {}) {
  const c: Content = structuredClone(TEST_CONTENT);
  edit(c);
  const store = createTestStore();
  store.append({ type: "turn_started", turn: 1, input: "" });
  const ctx = { store, rng: () => 0.99, content: c };
  runAfterTimeAdvance(ctx);
  executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
  return { store, ctx };
}
const act = (extra: Record<string, unknown>) => ({ intent: "일한다", check: null, deed: null, target: null, narration_summary: null, for_mission: true, activity: { kind: "work", until: null }, ...extra });

describe("균형 F", () => {
  const deliver = (keep: boolean) => {
    const { store, ctx } = setup((c) => {
      c.items.rope = { ...c.items.rope!, id: "rope" };
      c.missions.m_deliver = { id: "m_deliver", title: "밧줄 배달", briefing: "초소에 밧줄을 넘긴다", giver_rank: "squad_leader", deadline_hours: 12, where: "a_post", carries: { rope: 2 }, collects: { radio: 1 }, requirements: [{ deliver: "rope", quantity: 2 }] };
      c.roles.role_test!.missions = ["m_deliver"];
    });
    const me = () => store.getState().characters[store.getState().playerId]!;
    expect(executeTool("assign_mission", { template_id: "m_deliver" }, ctx).ok).toBe(true);
    expect(me().inventory.rope).toBe(2);
    expect(entrusted(store.getState()).rope).toBe(2);
    executeTool("take_action", act({ move_to: "a_post", activity: null }), ctx);
    // 받는 사람이 있어야 넘긴다 (PT20, 설계 목록 5-2)
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, ctx);
    const done = executeTool("take_action", act({ target: "npc_stranger" }), ctx);
    expect(done.ok && done.resultText).toContain("짐을 넘겼다");
    expect(done.ok && done.resultText).toContain("값을 받았다");
    expect(me().inventory.rope ?? 0).toBe(0);
    expect(me().inventory.radio).toBe(1);
    expect(entrusted(store.getState()).radio).toBe(1);
    if (!keep) executeTool("transfer_item", { from: me().id, to: "scene", item_id: "radio", quantity: 1 }, ctx);
    executeTool("take_action", act({ move_to: "a_home", activity: null, for_mission: false }), ctx);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    const r = executeTool("report_mission", {}, ctx);
    expect(me().inventory.radio ?? 0).toBe(0);
    return r.ok ? r.resultText : r.error;
  };

  it("배달 일감: 받을 때 맡은 짐을 받고, 임무 자리에서 넘기면 값을 받아, 보고 때 상관에게 넘긴다 (12-237)", () => {
    const text = deliver(true);
    expect(text).toContain("상관에게 넘겼다");
    expect(text).toContain("완수");
    expect(text).not.toContain("일부 완수");
  });

  it("받아 온 값을 빼돌리면 일부 완수까지다 (12-237)", () => {
    expect(deliver(false)).toContain("받아 올 값이 모자라 일부 완수까지다");
  });

  it("빚진 무리 사람에게 갚는다고 건네면 그 값만큼 빚이 준다. 그냥 건네면 선물이다 (12-237)", () => {
    const { store, ctx } = setup();
    const me = store.getState().playerId;
    store.append({ type: "debt_changed", characterId: me, factionId: "faction_a", delta: 5 });
    store.getState().characters[me]!.inventory.kitchen_knife = 2;
    const gift = executeTool("transfer_item", { from: me, to: "npc_leader", item_id: "kitchen_knife", quantity: 1 }, ctx);
    expect(gift.ok && gift.resultText).not.toContain("빚을 갚았다");
    expect(store.getState().characters[me]!.debts.faction_a).toBe(5);
    const out = executeTool("transfer_item", { from: me, to: "npc_leader", item_id: "kitchen_knife", quantity: 1, repay: true }, ctx);
    expect(out.ok && out.resultText).toContain("빚을 갚았다");
    expect(store.getState().characters[me]!.debts.faction_a ?? 0).toBeLessThan(5);
  });
});
