import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent, teachSkills } from "../testing.ts";

/** 가르침 (기획서 4.2.1): 전문 기술은 익힌 사람 곁에서 시간을 채워 배운다 */
const content = { ...loadRealContent(), storylets: {} };
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-lesson-")), content, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const lesson = (w: GameWorld, teacher: string, skill = "carpentry") =>
  w.executeTool("take_action", { intent: "배운다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, lesson: { teacher, skill } });
const rule = content.scenario.growth!.teaching!;

/** 장면에 들인 선생: 목공을 +1로 익혔고, 신뢰가 trust */
function teacher(w: GameWorld, id: string, trust: number) {
  if (!w.state().scene.present.includes(id)) w.ctx().store.append({ type: "npc_entered", npcId: id } as never);
  teachSkills(w, { carpentry: rule.min_skill }, id);
  const now = w.state().relations[id]?.[w.state().playerId]?.trust ?? 0;
  if (now !== trust) w.ctx().store.append({ type: "relation_changed", from: id, to: w.state().playerId, delta: { trust: trust - now, affection: 0, respect: 0 }, reason: "test" });
}

/** 다 배울 때까지 (또는 limit번) 수업을 받는다 */
function learnAll(w: GameWorld, id: string, limit = 30) {
  for (let i = 0; i < limit && me(w).skills.carpentry === undefined; i++) {
    const r = lesson(w, id);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  }
}

describe("가르침", () => {
  it(`${rule.hours}시간을 채우면 배운 상태(최저값)가 되고, 그 전에는 판정할 수 없다`, () => {
    const w = open();
    expect(me(w).skills.carpentry).toBeUndefined();
    teacher(w, "a_jiho", rule.min_trust);
    const first = lesson(w, "a_jiho");
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    expect(first.ok && first.resultText).toContain("배우는 중");
    expect(me(w).skills.carpentry).toBeUndefined();
    const start = w.state().time;
    learnAll(w, "a_jiho");
    expect(me(w).skills.carpentry).toBe(content.scenario.ranges.skill.min);
    expect(w.state().time - start).toBeGreaterThan(0);
    expect(w.state().lessons.carpentry).toBeUndefined(); // 다 배우면 쌓인 시간은 지운다
    // 이미 배웠으면 다시 배우지 않는다
    expect(lesson(w, "a_jiho").ok).toBe(false);
    w.close();
  });

  it("신뢰가 모자라거나, 선생이 익히지 않았거나, 누구나 하는 일이면 거절한다", () => {
    const w = open();
    teacher(w, "a_jiho", rule.min_trust - 1);
    const r = lesson(w, "a_jiho");
    expect(r.ok ? "" : r.error).toContain("믿지 않는다");
    expect(w.state().lessons.carpentry).toBeUndefined();
    expect(lesson(w, "a_jiho", "surgery").ok).toBe(false); // 선생이 익히지 않은 기술
    expect(lesson(w, "a_jiho", "fight").ok).toBe(false); // 누구나 하는 일
    w.close();
  });

  it(`다른 무리 사람은 처음 배울 때 값 ${rule.fee}어치를 받는다. 낼 것이 없으면 거절한다`, () => {
    const w = open();
    const other = Object.values(w.state().characters).find((c) => !c.dead && c.factionId && c.factionId !== me(w).factionId && !c.extra)!.id;
    teacher(w, other, rule.min_trust);
    // 가진 것을 다 내려놓으면 낼 것이 없다
    const bag = { ...me(w).inventory };
    for (const [itemId, quantity] of Object.entries(bag)) if (quantity > 0) w.ctx().store.append({ type: "item_consumed", holder: "player", itemId, quantity } as never);
    const broke = lesson(w, other);
    expect(broke.ok ? "" : broke.error).toContain("값");
    w.runCheat("~give cigarettes 10");
    const before = me(w).inventory.cigarettes ?? 0;
    const paid = lesson(w, other);
    expect(paid.ok, paid.ok ? "" : paid.error).toBe(true);
    expect(paid.ok && paid.resultText).toContain("가르침 값");
    const spent = before - (me(w).inventory.cigarettes ?? 0);
    expect(spent * (content.items.cigarettes?.value ?? 1)).toBeGreaterThanOrEqual(rule.fee);
    // 값은 한 번만
    const again = lesson(w, other);
    expect(again.ok && again.resultText).not.toContain("가르침 값");
    w.close();
  });
});
