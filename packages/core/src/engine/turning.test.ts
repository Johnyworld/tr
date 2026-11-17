import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { isInfected } from "../game/kinds.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { changeCondition } from "./body.ts";
import { aliasOf } from "../game/acquaintance.ts";
import { loadRealContent } from "../testing.ts";

/** 변이 (12-117): 감염으로 죽은 사람은 그 자리에 감염체로 남는다 */
const content = { ...loadRealContent(), storylets: {} };

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_turn", () => 0.5)]);
  const ctx = { store, rng: () => 0.99, content };
  return { store, ctx, state: () => store.getState() };
}
/** 감염의 마지막 바로 앞까지 보내 두고 한 단계 더 (죽음) */
function turn(ctx: ReturnType<typeof setup>["ctx"], id: string) {
  const s = ctx.store.getState();
  const levels = content.scenario.condition_tracks.find((t) => t.id === "infection")!.levels;
  s.characters[id]!.conditions.infection = levels[levels.length - 2]!.id;
  changeCondition(ctx, id, "infection", 1, "infection", "감염이 퍼진다");
}
const turnedOf = (state: ReturnType<ReturnType<typeof setup>["state"]>) =>
  Object.values(state.characters).filter((c) => isInfected(content, c) && c.extra?.label.startsWith("변이한"));

describe("변이", () => {
  it("장면에 있던 사람이 감염으로 죽으면 그 자리에서 감염체가 되어 장면에 남는다. 짐은 그것이 지닌다", () => {
    const { ctx, state } = setup();
    const s = state();
    const id = (s.known[s.playerId] ?? []).find((n) => content.npcs[n] && npcZoneAt(content.npcs[n]!, s.time))!;
    s.playerZone = npcZoneAt(content.npcs[id]!, s.time)!;
    s.scene.present.push(id);
    s.characters[id]!.inventory = { bandage: 2 };
    turn(ctx, id);
    const after = state();
    expect(after.characters[id]!.dead).toBe(true);
    const [t] = turnedOf(after);
    expect(t).toBeDefined();
    // 이름을 아는 사람이라 이름으로 부른다. 저장된 이름·호칭에는 이름이 없다
    expect(aliasOf(after, content, t!.id)).toBe(`변이한 ${after.characters[id]!.name}`);
    expect(t!.extra!.label).not.toContain(after.characters[id]!.name);
    expect(t!.name).not.toContain(after.characters[id]!.name);
    expect(t!.extra!.zone).toBe(after.playerZone);
    expect(t!.extra!.look).toContain("그 사람이었던 것");
    expect(t!.inventory).toEqual({ bandage: 2 });
    expect(after.characters[id]!.inventory).toEqual({});
    expect(after.scene.present).toContain(t!.id);
    expect((after.beliefs[after.playerId] ?? []).some((b) => b.fact.includes("감염체가 되었다"))).toBe(true);
  });

  it("다른 곳에서 죽은 사람은 그곳에 남고, 지금 장면에는 들어오지 않는다", () => {
    const { ctx, state } = setup();
    const s = state();
    s.playerZone = "a_base";
    const id = Object.keys(content.npcs).find((n) => {
      const z = npcZoneAt(content.npcs[n]!, s.time);
      return z && z !== "a_base" && !s.characters[n]!.captive;
    })!;
    turn(ctx, id);
    const [t] = turnedOf(state());
    expect(t!.extra!.zone).toBe(npcZoneAt(content.npcs[id]!, s.time));
    expect(state().scene.present).not.toContain(t!.id);
    // 보지 못했으니 만난 것으로 치지 않는다 (?인물 목록에 생기지 않는다)
    expect(state().met[state().playerId] ?? []).not.toContain(t!.id);
  });

  it("주인공이 변하면 그 구역에 남아 다음 캐릭터가 마주칠 수 있다", () => {
    const { ctx, state } = setup();
    const s = state();
    s.playerZone = "a_base";
    turn(ctx, s.playerId);
    const after = state();
    expect(after.characters[after.playerId]!.dead).toBe(true);
    const [t] = turnedOf(after);
    expect(t!.extra!.zone).toBe(after.playerZone);
    expect(after.scene.present).not.toContain(t!.id);
    const dead = after.characters[after.playerId]!;
    // 다음 캐릭터가 전 주인공의 이름을 알면 이름으로, 모르면 그 사람의 호칭(소속·계급)으로 부른다
    const stranger = Object.keys(after.characters).find((c) => content.npcs[c] && !(after.known[c] ?? []).includes(dead.id))!;
    const friend = Object.keys(after.characters).find((c) => content.npcs[c] && (after.known[c] ?? []).includes(dead.id));
    after.playerId = stranger;
    expect(aliasOf(after, content, t!.id)).toBe(`변이한 ${aliasOf(after, content, dead.id)}`);
    expect(aliasOf(after, content, t!.id)).not.toContain(dead.name);
    if (friend) {
      after.playerId = friend;
      expect(aliasOf(after, content, t!.id)).toBe(`변이한 ${dead.name}`);
    }
  });

  it("다른 까닭으로 죽으면 변하지 않는다", () => {
    const { ctx, state } = setup();
    const s = state();
    s.characters[s.playerId]!.conditions.harm = "unconscious";
    changeCondition(ctx, s.playerId, "harm", 1, "test", "다쳤다");
    expect(turnedOf(state())).toEqual([]);
  });
});
