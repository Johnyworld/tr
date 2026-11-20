import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { MISSION_CHECK_TRIES, MISSIONS_PER_DAY, pickDailyOffers } from "../game/missions.ts";
import type { Rng } from "../rng.ts";
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import { DISOBEDIENCE_FORGIVE_DAYS } from "./missionTools.ts";
import { learn } from "./reputationTools.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 균형 C (플레이 테스트 11): 임무 다시 굴리기·하루 임무 수·관계 하루 상한·불복종 지우기·계급 일감 */
function setup(rng: Rng = () => 0, content: Content = TEST_CONTENT) {
  const store = createTestStore();
  store.append({ type: "turn_started", turn: 1, input: "" });
  const ctx = { store, rng, content };
  runAfterTimeAdvance(ctx);
  executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
  return { store, ctx };
}
const check = (move: string) => ({
  intent: "살핀다", activity: null, deed: null, target: null, narration_summary: null, for_mission: true,
  check: { move, stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" },
});

describe("균형 C", () => {
  it("임무 판정이 빗나가면 30분이 들고, 세 번이면 그 조건이 닫힌다 (C2)", () => {
    const { store, ctx } = setup(() => 0); // 주사위 1+1, 늘 실패
    expect(executeTool("assign_mission", { template_id: "m_scout" }, ctx).ok).toBe(true);
    const t0 = store.getState().time;
    const first = executeTool("take_action", check("sense_danger"), ctx);
    expect(first.ok && first.resultText).toContain("30분을 더 썼다");
    expect(store.getState().time - t0).toBeGreaterThanOrEqual(30);
    for (let i = 1; i < MISSION_CHECK_TRIES; i++) executeTool("take_action", check("sense_danger"), ctx);
    const m = Object.values(store.getState().missions)[0]!;
    expect(m.fails[0]).toBe(MISSION_CHECK_TRIES);
    // 닫힌 뒤에는 성공해도 채워지지 않는다
    ctx.rng = () => 0.99;
    executeTool("take_action", check("sense_danger"), ctx);
    expect(store.getState().missions[m.id]!.progress[0]).toBe(0);
  });

  it("하루에 받을 수 있는 임무는 둘까지 (C3)", () => {
    const { store, ctx } = setup();
    for (let i = 0; i < MISSIONS_PER_DAY; i++) {
      store.append({ type: "missions_offered", day: 1, templateIds: ["m_guard"] });
      expect(executeTool("assign_mission", { template_id: "m_guard" }, ctx).ok).toBe(true);
      executeTool("abandon_mission", { reason: "다른 일" }, ctx);
    }
    store.append({ type: "missions_offered", day: 1, templateIds: ["m_guard"] });
    const third = executeTool("assign_mission", { template_id: "m_guard" }, ctx);
    expect(!third.ok && third.error).toContain("하루");
  });

  it("행적으로 오르는 관계는 축마다 하루 +1까지, 떨어지는 것은 자르지 않는다 (C6)", () => {
    const c: Content = structuredClone(TEST_CONTENT);
    c.npcs.npc_leader!.values = { ...c.npcs.npc_leader!.values, loyalty: 3 };
    const { store, ctx } = setup(() => 0, c);
    const s = store.getState();
    const deed = (id: string, tags: ("loyalty" | "betrayal")[], severity: number) => {
      const d = { id, actorId: s.playerId, summary: id, tags, severity, at: store.getState().time, witnesses: [], searched: false };
      store.append({ type: "deed_recorded", deed: d });
      learn(ctx, d, "npc_leader", "seen");
    };
    deed("d_a", ["loyalty"], 3);
    deed("d_b", ["loyalty"], 3);
    const up = { ...store.getState().relations.npc_leader![s.playerId]! };
    expect(Math.max(up.trust, up.affection, up.respect)).toBe(1);
    deed("d_c", ["betrayal"], 3);
    expect(store.getState().relations.npc_leader![s.playerId]!.trust).toBeLessThan(up.trust - 1);
  });

  it("불복종은 7일마다 하나씩 지워진다 (C8)", () => {
    const { store, ctx } = setup();
    executeTool("assign_mission", { template_id: "m_guard" }, ctx);
    executeTool("abandon_mission", { reason: "겁이 났다" }, ctx);
    expect(store.getState().characters.player!.disobedience).toBe(1);
    const now = store.getState().time;
    store.append({ type: "time_advanced", activity: "wait", from: now, to: now + DISOBEDIENCE_FORGIVE_DAYS * 24 * 60 });
    runAfterTimeAdvance(ctx);
    expect(store.getState().characters.player!.disobedience).toBe(0);
  });

  it("계급이 모자라면 그 일감은 후보에 오르지 않는다 (C9)", () => {
    const c: Content = structuredClone(TEST_CONTENT);
    c.missions.m_drill = { ...c.missions.m_guard!, id: "m_drill", min_rank: "squad_leader" };
    c.roles.role_test!.missions = ["m_drill", "m_guard"];
    expect(pickDailyOffers(c, "role_test", 1440, null, () => 0, [], false, undefined, "grunt")!.templateIds).not.toContain("m_drill");
    expect(pickDailyOffers(c, "role_test", 1440, null, () => 0, [], false, undefined, "squad_leader")!.templateIds).toContain("m_drill");
  });
});
