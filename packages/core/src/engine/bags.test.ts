import { describe, expect, it } from "vitest";
import { createWorldEvent, SCENE_HOLDER } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { bagsAt, carriedBags, heldCount, packItem, takeOut } from "../rules/bags.ts";
import { checkNeed } from "../rules/needs.ts";
import { carriedWeight } from "./gear.ts";
import { moveStash, packMoves } from "./stash.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 가방 (공통 규칙 26, docs/bags-plan.md): 가방이 내용물을 가지고, 옮기면 연결만 바뀐다 */
const content = loadRealContent();
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

function setup() {
  const c = { ...content, storylets: {} };
  const store = new InMemoryGameStore([createWorldEvent(c, "role_l_wanderer", "world_bags", () => 0.5)]);
  const ctx = { store, rng: () => 0.5, content: c };
  const me = () => store.getState().characters[store.getState().playerId]!;
  me().inventory = {};
  me().equipped = { weapon: null, body: null, head: null, arms: null, outer: null, back: null };
  store.getState().companions = [];
  store.getState().playerZone = "old_town";
  store.getState().playerPlace = null;
  return { store, ctx, me, s: () => store.getState() };
}

const bagOf = (s: ReturnType<typeof setup>["s"], at: string) => bagsAt(s(), at)[0];

describe("가방 (공통 규칙 26)", () => {
  it("빈 가방에 넣으면 개체가 생기고 내용물은 가방만 가진다. 멘 가방만 안의 무게가 준다", () => {
    const { ctx, me, s } = setup();
    me().inventory = { military_pack: 1, canned_food: 10 };
    const base = carriedWeight(content, me(), s());
    const r = packItem(ctx, me().id, { bagItem: "military_pack" }, "canned_food", 10);
    expect(r.ok).toBe(true);
    const [id, bag] = bagOf(s, me().id)!;
    expect(bag.contents).toEqual({ canned_food: 10 });
    expect(me().inventory.canned_food).toBeUndefined();
    expect(heldCount(s(), me().id, "canned_food")).toBe(10);
    // 메지 않으면 무게 그대로
    expect(carriedWeight(content, me(), s())).toBeCloseTo(base);
    const worn = executeTool("equip", { item_id: null, slot: null, bag_id: id }, ctx);
    expect(worn.ok).toBe(true);
    expect(me().equipped.back).toBe("military_pack");
    // 통조림 4kg의 80%가 주고, 착용한 배낭 2kg도 70%로 센다
    expect(carriedWeight(content, me(), s())).toBeCloseTo(base - 4 * 0.8 - 2 * 0.3);
  });

  it("용량을 넘게 넣지 못하고, 가방에 가방은 넣지 못한다", () => {
    const { ctx, me } = setup();
    me().inventory = { shoulder_bag: 1, school_bag: 1, scrap_metal: 7 };
    expect(packItem(ctx, me().id, { bagItem: "shoulder_bag" }, "scrap_metal", 7).ok).toBe(false);
    expect(packItem(ctx, me().id, { bagItem: "shoulder_bag" }, "scrap_metal", 6).ok).toBe(true);
    expect(packItem(ctx, me().id, { bagItem: "school_bag" }, "shoulder_bag", 1).ok).toBe(false);
  });

  it("가방을 바닥에 내려놓으면 내용물째 남고, 구역을 오가도 그대로이며, 다른 사람이 주우면 내용물째 주워진다", () => {
    const { ctx, me, s, store } = setup();
    me().inventory = { hiking_pack: 1, canned_food: 3, rope: 1 };
    packItem(ctx, me().id, { bagItem: "hiking_pack" }, "canned_food", 3);
    packItem(ctx, me().id, { bagItem: "hiking_pack" }, "rope", 1);
    const [id] = bagOf(s, me().id)!;
    const dropped = executeTool("transfer_item", { from: me().id, to: SCENE_HOLDER, item_id: "hiking_pack", quantity: 1, bag_id: id }, ctx);
    expect(dropped.ok ? "" : dropped.error).toBe("");
    expect(s().bags[id]!.at).toBe(SCENE_HOLDER);
    expect(s().scene.items.hiking_pack).toBe(1);
    expect(s().scene.items.canned_food).toBeUndefined();
    // 구역을 떠나면 그 자리 바닥에, 돌아오면 다시 장면에
    const here = s().playerZone!;
    const there = Object.keys(content.locations).find((z) => z !== here)!;
    store.append({ type: "zone_moved", from: here, to: there });
    expect(s().bags[id]!.at.startsWith("ground:")).toBe(true);
    store.append({ type: "zone_moved", from: there, to: here });
    expect(s().bags[id]!.at).toBe(SCENE_HOLDER);
    // 다른 사람(계승한 주인공 자리)이 주워도 내용물째
    const other = Object.keys(s().characters).find((c) => c !== me().id && !s().characters[c]!.dead)!;
    store.append({ type: "item_transferred", from: SCENE_HOLDER, to: other, itemId: "hiking_pack", quantity: 1 });
    expect(s().bags[id]!.at).toBe(other);
    expect(s().bags[id]!.contents).toEqual({ canned_food: 3, rope: 1 });
  });

  it("가방 속 물건을 쓰면 꺼내 쓰고 남은 것은 다시 넣는다 (GM이 서술할 줄이 나온다)", () => {
    const { ctx, me, s } = setup();
    me().inventory = { school_bag: 1, water_bottle: 1 };
    packItem(ctx, me().id, { bagItem: "school_bag" }, "water_bottle", 1);
    const thirst = content.scenario.condition_tracks.find((t) => t.id === "thirst")!;
    me().conditions.thirst = thirst.levels[2]!.id;
    const out = executeTool("take_action", act({ intent: "물을 마신다", use_item: "water_bottle" }), ctx);
    expect(out.ok && out.resultText).toContain("가방(책가방)에서 물병을 꺼냈다");
    expect(out.ok && out.resultText).toContain("빈 물병을 가방(책가방)에 다시 넣었다");
    expect(bagOf(s, me().id)![1].contents).toEqual({ empty_bottle: 1 });
  });

  it("가방 속 필수품도 가진 것이고, takeOut은 같은 가방에 돌려놓는다", () => {
    const { ctx, me, s } = setup();
    me().inventory = { tote_bag: 1, rope: 1 };
    packItem(ctx, me().id, { bagItem: "tote_bag" }, "rope", 1);
    expect(checkNeed(content, s(), me().id, "climb")).toEqual({ ok: true, item: "rope", parts: [] });
    const t = takeOut(ctx, me().id, "rope");
    expect(me().inventory.rope).toBe(1);
    expect(t.restore()[0]).toContain("다시 넣었다");
    expect(me().inventory.rope).toBeUndefined();
  });

  it("맨몸에 모자라면 리듀서가 가방에서 덜어 쓰고, 가방이 없어지면 내용물이 쏟아진다", () => {
    const { ctx, me, s, store } = setup();
    me().inventory = { shoulder_bag: 1, rifle_rounds: 3 };
    packItem(ctx, me().id, { bagItem: "shoulder_bag" }, "rifle_rounds", 3);
    store.append({ type: "item_consumed", holder: me().id, itemId: "rifle_rounds", quantity: 1 });
    expect(bagOf(s, me().id)![1].contents).toEqual({ rifle_rounds: 2 });
    store.append({ type: "item_consumed", holder: me().id, itemId: "shoulder_bag", quantity: 1 });
    expect(bagsAt(s(), me().id)).toEqual([]);
    expect(me().inventory.rifle_rounds).toBe(2);
  });

  it("든 가방은 창고에 내용물째 넣고 꺼내며, 흥정으로 내주지 못한다", () => {
    const { ctx, me, s, store } = setup();
    me().inventory = { hiking_pack: 1, canned_food: 2 };
    packMoves(ctx, "pack", [{ item_id: "canned_food", quantity: 2 }], null, "hiking_pack");
    const [id] = bagOf(s, me().id)!;
    // 거처를 정하고 넣는다
    store.append({ type: "home_settled", characterId: me().id, zone: s().playerZone! });
    const put = moveStash(ctx, "put", [{ item_id: "hiking_pack", quantity: 1, bag_id: id }]);
    expect(put.ok ? "" : put.error).toBe("");
    expect(s().bags[id]!.at).toBe(`stash:${me().id}:${s().playerZone}`);
    const take = moveStash(ctx, "take", [{ item_id: "hiking_pack", quantity: 1, bag_id: id }]);
    expect(take.ok).toBe(true);
    expect(s().bags[id]!.contents).toEqual({ canned_food: 2 });
    // 흥정: 든 가방은 내주지 못한다
    const npc = Object.keys(s().characters).find((c) => c !== me().id && !s().characters[c]!.dead && !!content.npcs[c])!;
    s().scene.present.push(npc);
    const barter = executeTool("barter", { npc_id: npc, give: { hiking_pack: 1 }, get: {}, move: null, stat: null }, ctx);
    expect(!barter.ok && barter.error).toContain("먼저 비운다");
  });

  it("지닌 가방 목록에는 든 가방과 빈 가방이 함께 보인다", () => {
    const { ctx, me, s } = setup();
    me().inventory = { tote_bag: 2, canned_food: 1 };
    packItem(ctx, me().id, { bagItem: "tote_bag" }, "canned_food", 1);
    const list = carriedBags(content, s(), me().id);
    expect(list.map((b) => [b.item, !!b.id, b.load])).toEqual([
      ["tote_bag", true, 0.4],
      ["tote_bag", false, 0],
    ]);
  });
});
