import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { checkPromotion, evaluateMission } from "../game/missions.ts";

const PROMO = TEST_CONTENT.scenario.promotion;
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import { describeMissionsForGm } from "./missionTools.ts";
import { runAfterTimeAdvance as runStartOfTurn } from "./turnStart.ts";
import { executeTool } from "./tools.ts";

const first: Rng = () => 0; // 후보는 목록 순서대로, 판정은 1+1
const sixes: Rng = () => 0.99;

function setup(rng: Rng = first) {
  const store = createTestStore();
  store.append({ type: "turn_started", turn: 1, input: "" });
  const ctx = { store, rng, content: TEST_CONTENT };
  runStartOfTurn(ctx);
  return { store, ctx };
}

function withLeader(env: ReturnType<typeof setup>) {
  executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
  return env;
}

describe("임무 배정", () => {
  it("날이 바뀔 때만 오늘의 후보가 정해진다", () => {
    const { store, ctx } = setup();
    expect(store.getState().offers).toEqual({ day: 1, templateIds: ["m_guard", "m_scout"] });
    runStartOfTurn(ctx);
    expect(store.events().filter((e) => e.type === "missions_offered")).toHaveLength(1);
  });

  it("상관이 장면에 있어야 배정할 수 있다", () => {
    const env = setup();
    expect(executeTool("assign_mission", { template_id: "m_guard" }, env.ctx).ok).toBe(false);
    withLeader(env);
    const out = executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    expect(out.ok).toBe(true);
    const mission = env.store.getState().missions.m_1;
    expect(mission).toMatchObject({ status: "active", giverId: "npc_leader", deadline: 330 + 12 * 60 });
  });

  it("오늘의 후보가 아니거나 이미 임무가 있으면 거부한다", () => {
    const env = withLeader(setup());
    expect(executeTool("assign_mission", { template_id: "made_up" }, env.ctx).ok).toBe(false);
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    expect(executeTool("assign_mission", { template_id: "m_scout" }, env.ctx).ok).toBe(false);
  });
});

describe("임무 수행과 보고", () => {
  it("임무를 받은 뒤의 활동만 진행도로 집계되고, 보고 결과는 코드가 정한다", () => {
    const env = withLeader(setup(sixes));
    executeTool("take_action", { intent: "행동", check: null, deed: null, target: null, narration_summary: null, activity: { kind: "guard_duty", until: null } }, env.ctx); // 배정 전: 집계 안 됨
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    executeTool("take_action", { intent: "행동", check: null, deed: null, target: null, narration_summary: null, activity: { kind: "guard_duty", until: null } }, env.ctx);
    expect(env.store.getState().missions.m_1?.progress).toEqual([240]);

    const out = executeTool("report_mission", {}, env.ctx);
    expect(out.ok && out.display).toMatchObject({ type: "mission", event: "reported", detail: "완수", merit: 3 });
    expect(env.store.getState().characters.player?.merit).toBe(3);
    expect(env.store.getState().missions.m_1?.status).toBe("completed");
  });

  it("일부만 하면 일부 완수, 아무것도 안 하면 실패", () => {
    const env = withLeader(setup(sixes));
    executeTool("assign_mission", { template_id: "m_scout" }, env.ctx);
    executeTool(
      "take_action",
      {
        intent: "살핀다",
        check: { move: "sense_danger", stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" },
        activity: null,
        deed: null,
        target: null,
        narration_summary: null,
      },
      env.ctx,
    );
    const mission = env.store.getState().missions.m_1!;
    expect(evaluateMission(mission, mission.assignedAt)).toMatchObject({ outcome: "partial", merit: 1 });
    expect(evaluateMission({ ...mission, progress: [0, 0] }, mission.assignedAt).outcome).toBe("failed");
    expect(evaluateMission(mission, mission.deadline + 1)).toMatchObject({ late: true, merit: 0 });
  });

  it("보고는 상관이 장면에 있어야 한다", () => {
    const env = withLeader(setup());
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "leave" }, env.ctx);
    expect(executeTool("report_mission", {}, env.ctx).ok).toBe(false);
  });
});

describe("명령 불복종", () => {
  it("포기하면 불복종이 기록되고 공적이 깎인다", () => {
    const env = withLeader(setup());
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    expect(executeTool("abandon_mission", { reason: "겁이 났다" }, env.ctx).ok).toBe(true);
    const player = env.store.getState().characters.player!;
    expect(player).toMatchObject({ merit: -2, disobedience: 1 });
  });

  it("기한이 지나면 시간이 흐른 직후 기한 초과로 끝난다", () => {
    const env = withLeader(setup(() => 0.999));
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    // 05:30 → 20:00 (기한 17:30)
    const out = executeTool(
      "take_action",
      { intent: "잔다", check: null, deed: null, target: null, narration_summary: null, activity: { kind: "sleep", until: "night" } },
      env.ctx,
    );
    expect(out.ok && out.extra).toContainEqual(expect.objectContaining({ type: "mission", event: "expired" }));
    expect(env.store.getState().characters.player).toMatchObject({ merit: -2, disobedience: 1 });
  });
});

describe("진급", () => {
  const base = createTestStore().getState().characters.player!;

  it("공적·복무 기간·불복종·상관 신뢰 조건을 모두 채워야 한다", () => {
    const day = 24 * 60;
    expect(checkPromotion({ ...base, merit: 9 }, PROMO, 330 + 4 * day, 330, 2).eligible).toBe(true);
    expect(checkPromotion({ ...base, merit: 8 }, PROMO, 330 + 4 * day, 330, 2).missing).toEqual(["공적 8/9"]);
    expect(checkPromotion({ ...base, merit: 9 }, PROMO, 330 + 3 * day, 330, 2).missing).toEqual(["복무 3/4일"]);
    expect(checkPromotion({ ...base, merit: 9, disobedience: 2 }, PROMO, 330 + 4 * day, 330, 2).eligible).toBe(false);
    expect(checkPromotion({ ...base, merit: 9 }, PROMO, 330 + 4 * day, 330, 1).missing).toEqual(["상관 신뢰 1/2"]);
    expect(checkPromotion({ ...base, merit: 9 }, PROMO, 330 + 4 * day, 330, null).eligible).toBe(true);
  });

  it("조건을 채운 상태로 보고하면 진급한다", () => {
    const env = withLeader(setup(sixes));
    // 복무 4일이 지났고 공적 6, 상관 신뢰 1이 쌓인 상태로 만든다
    env.store.getState().characters.player!.merit = 6;
    env.store.getState().relations.npc_leader = { player: { trust: 1, affection: 0, respect: 0 } };
    env.store.append({ type: "time_advanced", activity: "wait", from: 330, to: 330 + 4 * 24 * 60 });
    env.store.append({ type: "missions_offered", day: 5, templateIds: ["m_guard"] });
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    executeTool("take_action", { intent: "행동", check: null, deed: null, target: null, narration_summary: null, activity: { kind: "guard_duty", until: null } }, env.ctx);
    const out = executeTool("report_mission", {}, env.ctx);
    expect(out.ok && out.extra).toMatchObject([{ type: "promotion", toLabel: "분대장" }]);
    expect(env.store.getState().characters.player?.rank).toBe(PROMO.to);
  });
});

describe("GM 컨텍스트", () => {
  it("임무가 없으면 오늘의 후보를, 있으면 진행 상황을 보여 준다", () => {
    const env = withLeader(setup());
    expect(describeMissionsForGm(env.store.getState(), env.ctx)).toContain("m_guard: 초소 보초");
    executeTool("assign_mission", { template_id: "m_guard" }, env.ctx);
    const text = describeMissionsForGm(env.store.getState(), env.ctx);
    expect(text).toContain("수행 중인 임무");
    expect(text).toContain("보초 4시간 (지금까지 0분, 미충족)");
  });
});
