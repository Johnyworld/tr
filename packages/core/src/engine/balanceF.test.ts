import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 균형 F (플레이 테스트 11): 배달 일감의 짐과 품삯, 물건으로 빚 갚기 */
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
  it("배달 일감: 받을 때 짐을 받고, 임무 자리에서 넘기고, 보고하면 품삯을 받는다", () => {
    const { store, ctx } = setup((c) => {
      c.items.rope = { ...c.items.rope!, id: "rope" };
      c.missions.m_deliver = { id: "m_deliver", title: "밧줄 배달", briefing: "초소에 밧줄을 넘긴다", giver_rank: "squad_leader", deadline_hours: 12, where: "a_post", carries: { rope: 2 }, pay: { radio: 1 }, requirements: [{ deliver: "rope", quantity: 2 }] };
      c.roles.role_test!.missions = ["m_deliver"];
    });
    const me = () => store.getState().characters[store.getState().playerId]!;
    expect(executeTool("assign_mission", { template_id: "m_deliver" }, ctx).ok).toBe(true);
    expect(me().inventory.rope).toBe(2);
    executeTool("take_action", act({ move_to: "a_post", activity: null }), ctx);
    const done = executeTool("take_action", act({}), ctx);
    expect(done.ok && done.resultText).toContain("짐을 넘겼다");
    expect(me().inventory.rope ?? 0).toBe(0);
    executeTool("take_action", act({ move_to: "a_home", activity: null, for_mission: false }), ctx);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    const r = executeTool("report_mission", {}, ctx);
    expect(r.ok && r.resultText).toContain("품삯");
    expect(me().inventory.radio).toBe(1);
  });

  it("빚진 무리 사람에게 물건을 건네면 그 값만큼 빚이 준다", () => {
    const { store, ctx } = setup();
    const me = store.getState().playerId;
    store.append({ type: "debt_changed", characterId: me, factionId: "faction_a", delta: 5 });
    const out = executeTool("transfer_item", { from: me, to: "npc_leader", item_id: "kitchen_knife", quantity: 1 }, ctx);
    expect(out.ok && out.resultText).toContain("빚을 갚았다");
    expect(store.getState().characters[me]!.debts.faction_a ?? 0).toBeLessThan(5);
  });
});
