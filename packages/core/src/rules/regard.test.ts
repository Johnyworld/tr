import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { runAfterTimeAdvance } from "../engine/turnStart.ts";
import { applyEffect } from "../engine/storyletTools.ts";
import type { StoryletEffect } from "../content/schemas.ts";
import { loadRealContent } from "../testing.ts";
import { changeRelation, gateRegard, REGARD_KINDS } from "./regard.ts";
import { learn } from "../engine/reputationTools.ts";
import { MINUTES_PER_DAY } from "./time.ts";

/** 공통 규칙 19: 관계 오름 (같은 까닭 3일, 하루 상한, 무거운 까닭, 내리막) */
const content = loadRealContent();

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_regard", () => 0.5)]);
  const ctx = { store, rng: () => 0.99, content };
  runAfterTimeAdvance(ctx);
  const s = store.getState();
  const npc = Object.keys(s.characters).find((id) => id !== s.playerId && !s.characters[id]!.dead)!;
  const rel = () => store.getState().relations[npc]?.[store.getState().playerId] ?? NEUTRAL_RELATION;
  const wait = (days: number) => {
    const t = store.getState().time;
    store.append({ type: "time_advanced", activity: "wait", from: t, to: t + days * MINUTES_PER_DAY });
  };
  const gain = (delta: Record<string, number>, kind: string, reason = "판결 수용") => changeRelation(ctx, { from: npc, to: s.playerId, delta, reason, kind });
  return { store, ctx, npc, rel, wait, gain, me: s.playerId };
}

describe("관계 오름", () => {
  it("같은 사람·축·까닭으로 3일 안에 다시 오르면 0, GM 한 줄이 남는다", () => {
    const { rel, wait, gain } = setup();
    const before = rel().trust;
    gain({ trust: 1 }, "verdict_accepted");
    expect(rel().trust).toBe(before + 1);
    wait(1);
    const r = gain({ trust: 1 }, "verdict_accepted");
    expect(rel().trust).toBe(before + 1);
    expect(r.note).toContain("같은 일로는 더 마음이 움직이지 않는다: 판결 수용, 3일 안");
    wait(1);
    gain({ trust: 1 }, "verdict_accepted");
    expect(rel().trust).toBe(before + 1);
  });

  it("3일이 지나면 같은 까닭으로 다시 +1", () => {
    const { rel, wait, gain } = setup();
    const before = rel().trust;
    gain({ trust: 1 }, "verdict_accepted");
    wait(3);
    gain({ trust: 1 }, "verdict_accepted");
    expect(rel().trust).toBe(before + 2);
  });

  it("가벼운 까닭은 서로 달라도 한 사람·한 축 하루 +1까지, 다음 날 다시 오른다", () => {
    const { rel, wait, gain } = setup();
    const before = rel();
    gain({ affection: 2 }, "gift", "선물");
    expect(rel().affection).toBe(before.affection + 1);
    const r = gain({ affection: 1, trust: 1 }, "favor", "들어준 부탁");
    expect(rel().affection).toBe(before.affection + 1);
    expect(rel().trust).toBe(before.trust + 1); // 다른 축은 따로 센다
    expect(r.note).toContain("오늘은 더 마음이 움직이지 않는다");
    wait(1);
    gain({ affection: 1 }, "burial", "묻어 주었다");
    expect(rel().affection).toBe(before.affection + 2);
  });

  it("무거운 까닭은 하루 상한을 넘는다 (같은 까닭 간격은 그대로)", () => {
    const { rel, gain } = setup();
    const before = rel().trust;
    gain({ trust: 1 }, "gift");
    gain({ trust: 2 }, "rescue", "구출");
    expect(rel().trust).toBe(before + 3);
    gain({ trust: 2 }, "rescue", "구출");
    expect(rel().trust).toBe(before + 3);
  });

  it("내리막은 줄이지 않는다", () => {
    const { rel, gain } = setup();
    const before = rel().trust;
    gain({ trust: -2 }, "promise", "어긴 약속");
    gain({ trust: -2 }, "promise", "어긴 약속");
    expect(rel().trust).toBe(before - 4);
  });

  it("NPC끼리의 관계는 거르지 않는다", () => {
    const { store, ctx, npc, me } = setup();
    const s = store.getState();
    const other = Object.keys(s.characters).find((id) => id !== me && id !== npc)!;
    const before = s.relations[npc]?.[other]?.trust ?? 0;
    changeRelation(ctx, { from: npc, to: other, delta: { trust: 2 }, reason: "테스트", kind: "x" });
    changeRelation(ctx, { from: npc, to: other, delta: { trust: 2 }, reason: "테스트", kind: "x" });
    expect(store.getState().relations[npc]?.[other]?.trust).toBe(Math.min(10, before + 4));
  });

  it("이야기 효과: 하루 상한 없이 작가가 정한 크기대로, kind가 없으면 이야기 id가 까닭", () => {
    const { ctx, rel, npc } = setup();
    const before = rel().trust;
    const big = { relation: { who: "x", axis: "trust", delta: 2 } } as StoryletEffect;
    const small = { relation: { who: "x", axis: "trust", delta: 1 } } as StoryletEffect;
    applyEffect(ctx, small, { x: npc }, {}, "이야기 하나", { source: "s_one" });
    applyEffect(ctx, big, { x: npc }, {}, "이야기 둘", { source: "s_two" });
    expect(rel().trust).toBe(before + 3);
    const again = applyEffect(ctx, small, { x: npc }, {}, "이야기 하나", { source: "s_one" });
    expect(rel().trust).toBe(before + 3);
    expect(again.line).toContain("같은 일로는");
  });

  it("행적: 주인공의 같은 꼬리표는 3일 간격, 하루 상한", () => {
    const { store, npc, me, content: c } = { ...setup(), content };
    const s = store.getState();
    const deed = { tags: ["diligence"] as const };
    const kind = `deed:${deed.tags.join("+")}`;
    store.append({ type: "relation_changed", from: npc, to: me, delta: { trust: 1, affection: 0, respect: 0 }, reason: "행적", kind });
    const g = gateRegard(store.getState(), c, npc, me, kind, { trust: 1, respect: 1 }, { reason: "성실" });
    expect(g.delta.trust).toBe(0);
    expect(g.delta.respect).toBe(1);
    expect(gateRegard(store.getState(), c, npc, me, kind, { trust: 1 }, { sameWindow: false, reason: "성실" }).delta.trust).toBe(0); // 하루 상한
    expect(s.time).toBeGreaterThanOrEqual(0);
  });

  it("임무 완수(하루 상한만 받는 까닭)는 다음 날 다시 오르고, 같은 날 두 번째는 하루 상한에 막힌다 (12-298)", () => {
    const { store, ctx, me, wait } = setup();
    const npc = "a_taeho"; // 졸병의 상관 (성실을 좋게 본다)
    expect(store.getState().characters[npc]).toBeDefined();
    const rel = () => store.getState().relations[npc]?.[me] ?? NEUTRAL_RELATION;
    const deed = (n: number) => {
      const d = { id: `d_t${n}`, actorId: me, summary: "임무 완수: 시험", tags: ["diligence" as const], severity: 1, at: store.getState().time, witnesses: [], searched: false };
      store.append({ type: "deed_recorded", deed: d });
      return d;
    };
    const before = rel().trust;
    learn(ctx, deed(1), npc, "report", ["trust", "respect"], REGARD_KINDS.missionDone);
    const first = rel().trust - before;
    expect(first).toBe(1);
    learn(ctx, deed(2), npc, "report", ["trust", "respect"], REGARD_KINDS.missionDone);
    expect(rel().trust - before).toBe(first); // 같은 날: 하루 상한
    wait(1);
    learn(ctx, deed(3), npc, "report", ["trust", "respect"], REGARD_KINDS.missionDone);
    expect(rel().trust - before).toBe(first * 2); // 다음 날: 같은 까닭 간격을 받지 않는다
    wait(1);
    learn(ctx, deed(4), npc, "seen", ["trust", "respect"]); // 까닭을 주지 않은 같은 꼬리표 행적은 그대로 3일 간격
    expect(rel().trust - before).toBe(first * 2);
  });
});
