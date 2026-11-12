import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import { recordDeed, spreadRumors, type DeedInput } from "./reputationTools.ts";
import { executeTool } from "./tools.ts";

function setup(rng: Rng) {
  const store = createTestStore();
  store.append({ type: "turn_started", turn: 1, input: "" });
  return { store, ctx: { store, rng, content: TEST_CONTENT } };
}

const theft: DeedInput = {
  summary: "창고에서 통조림을 훔쳤다",
  tags: ["theft"],
  severity: 2,
  privacy: "public",
  noisy: false,
};

describe("행적 기록", () => {
  it("장면에 있는 인물은 보고, 관계가 그 인물의 가치관대로 바뀐다", () => {
    const { store, ctx } = setup(() => 0.999); // 숨은 목격자 없음
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    const out = recordDeed(ctx, { ...theft, tags: ["disobedience"] });
    expect(out.visible).toEqual(["강분대"]);
    // 규율 +3인 분대장: 불복종(심각도 2) → 신뢰·존중 하락
    expect(store.getState().relations.npc_leader?.player).toEqual({ trust: -2, affection: 0, respect: -2 });
    expect(store.getState().deedKnowledge.npc_leader).toEqual({ d_1: "seen" });
  });

  it("숨은 목격자는 결과 문구와 화면 표시에 나오지 않는다", () => {
    const { store, ctx } = setup(() => 0); // 장면 밖 NPC가 모두 숨어서 본다
    const out = recordDeed(ctx, theft);
    const deed = store.getState().deeds.d_1!;
    expect(deed.witnesses).toEqual([
      { npcId: "npc_leader", hidden: true },
      { npcId: "npc_stranger", hidden: true },
    ]);
    expect(out.visible).toEqual([]); // 화면·GM에 보내는 목격자 목록에는 없다
    // 플레이어가 느끼는 태도는 그 인물을 만나기 전까지 바뀌지 않는다
    expect(store.getState().relations.npc_leader?.player?.trust).toBeLessThan(0);
    expect(store.getState().perceived.npc_leader).toBeUndefined();
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    expect(store.getState().perceived.npc_leader?.trust).toBeLessThan(0);
  });
});

describe("look_for_witnesses", () => {
  it("성공하면 숨은 목격자를 알게 되고, 행적 하나에 한 번만 살핀다", () => {
    const rng = (() => {
      const seq = [0, 0.999, 0.99, 0.99]; // 분대장만 숨어서 봄 → 판정 6+6
      let i = 0;
      return () => seq[i++ % seq.length]!;
    })();
    const { store, ctx } = setup(rng);
    recordDeed(ctx, theft);
    const out = executeTool("look_for_witnesses", { deed_id: "d_1" }, ctx);
    expect(out.ok && out.extra).toMatchObject([{ type: "belief", fact: "강분대가 보고 있었다." }]);
    expect(store.getState().beliefs.player?.at(-1)?.fact).toContain("강분대");
    expect(executeTool("look_for_witnesses", { deed_id: "d_1" }, ctx).ok).toBe(false);
  });

  it("실패하면 아무것도 알지 못한다", () => {
    const { store, ctx } = setup(() => 0); // 모두 숨어서 봄, 판정 1+1
    recordDeed(ctx, theft);
    const before = store.getState().beliefs.player?.length;
    const out = executeTool("look_for_witnesses", { deed_id: "d_1" }, ctx);
    expect(out.ok && out.extra).toEqual([]);
    expect(store.getState().beliefs.player?.length).toBe(before);
  });
});

describe("reveal_secret", () => {
  it("신뢰가 조건에 못 미치면 털어놓지 않고, 채우면 플레이어가 알게 된다", () => {
    const { store, ctx } = setup(() => 0.5);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    expect(executeTool("reveal_secret", { npc_id: "npc_leader" }, ctx).ok).toBe(false);

    store.getState().relations.npc_leader = { player: { trust: 4, affection: 0, respect: 0 } };
    expect(executeTool("reveal_secret", { npc_id: "npc_leader" }, ctx).ok).toBe(true);
    expect(store.getState().beliefs.player?.at(-1)?.fact).toContain("정찰조를 버리고 후퇴했다");
    expect(executeTool("reveal_secret", { npc_id: "npc_leader" }, ctx).ok).toBe(false);
  });
});

describe("소문 전파", () => {
  it("날이 바뀌면 아는 사람이 모르는 사람에게 옮기고, 듣는 사람의 관계가 바뀐다", () => {
    const { store, ctx } = setup(() => 0); // 모든 확률 통과
    spreadRumors(ctx); // 기준일 1일차
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, ctx);
    recordDeed(ctx, { summary: "통조림 도둑질", tags: ["theft"], severity: 2, privacy: "private", noisy: false });
    // rng 0이면 분대장도 숨은 목격자가 되므로, 분대장의 지식을 지우고 다시 확인한다
    delete store.getState().deedKnowledge.npc_leader;
    store.append({ type: "time_advanced", activity: "sleep", from: 330, to: 330 + 24 * 60 });
    spreadRumors(ctx);
    expect(store.getState().deedKnowledge.npc_leader).toEqual({ d_1: "report" });
    expect(store.getState().lastSpreadDay).toBe(2);
  });
});

describe("임무와 평판", () => {
  it("임무 완수는 상관의 신뢰를, 포기는 불신을 남긴다", () => {
    const { store, ctx } = setup(() => 0.999);
    spreadRumors(ctx);
    store.append({ type: "missions_offered", day: 1, templateIds: ["m_guard", "m_scout"] });
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    executeTool("assign_mission", { template_id: "m_guard" }, ctx);
    executeTool("take_action", { intent: "행동", check: null, deed: null, target: null, narration_summary: null, for_mission: true, activity: { kind: "guard_duty", until: null } }, ctx);
    executeTool("report_mission", {}, ctx);
    expect(store.getState().relations.npc_leader?.player?.trust).toBe(1);

    store.append({ type: "missions_offered", day: 1, templateIds: ["m_scout"] });
    executeTool("assign_mission", { template_id: "m_scout" }, ctx);
    executeTool("abandon_mission", { reason: "겁이 났다" }, ctx);
    expect(store.getState().relations.npc_leader?.player?.trust).toBe(-1);
  });
});
