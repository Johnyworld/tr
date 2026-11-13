import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createContentSchemas } from "../content/schemas.ts";
import { initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 12-54: 맡기기, 산출 늘리기, 배우기, 시간 쓰기, 지금 구역의 주인, 남겨 둔 사람 */
const base = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const parse = createContentSchemas(base.scenario).storylet.parse;
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-54-")), content: base, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
const resolveWith = (w: ReturnType<typeof open>, effects: unknown[]) => {
  const s = parse({ id: "t54", title: "t", setup: "x", choices: [{ id: "a", label: "a", effects }] });
  const ctx = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, t54: s } } };
  fireStorylet(ctx, s, {});
  return executeTool("resolve_storylet", { choice_id: "a" }, ctx);
};
const go = (w: ReturnType<typeof open>, to: string) =>
  w.executeTool("take_action", { intent: "이동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, move_to: to });

describe("12-54 빈틈", () => {
  it("무기를 맡기면 손에서 빠지고, 그 구역을 떠날 때 돌려받는다", () => {
    const w = open();
    const me = () => w.state().characters[w.state().playerId]!;
    expect(me().inventory.kitchen_knife).toBeGreaterThan(0);
    resolveWith(w, [{ deposit_weapons: true }]);
    expect(me().inventory.kitchen_knife).toBeUndefined();
    expect(me().equipped?.weapon ?? null).toBeNull();
    const out = go(w, "old_town");
    expect(out.ok && out.resultText).toContain("맡겨 둔 것을 돌려받고");
    expect(me().inventory.kitchen_knife).toBeGreaterThan(0);
  });

  it("우리 땅의 산출을 늘리면 전쟁 틱의 생산에 더해진다", () => {
    const w = open();
    resolveWith(w, [{ cultivate: { resource: "food", delta: 5 } }]);
    expect(w.state().zones.a_base!.boost).toEqual({ food: 5 });
    const world = initialWarWorld(base);
    const plain = simulateWarDay(structuredClone(world), base, createSeededRng(1)).factions.faction_a!.resources.food!;
    world.zones.a_base = { ...world.zones.a_base!, boost: { food: 5 } };
    expect(simulateWarDay(world, base, createSeededRng(1)).factions.faction_a!.resources.food!).toBeGreaterThan(plain);
  });

  it("배우면 스킬이 max까지 한 단계 오르고, 시간을 쓰면 시계가 간다", () => {
    const w = open();
    const before = w.state().characters[w.state().playerId]!.skills.history ?? -1;
    resolveWith(w, [{ train: { skill: "history", max: 1 } }]);
    expect(w.state().characters[w.state().playerId]!.skills.history).toBe(before + 1);
    const t = w.state().time;
    resolveWith(w, [{ delay: 120 }]);
    expect(w.state().time).toBeGreaterThanOrEqual(t + 120);
  });

  it("zone_owner는 지금 구역의 주인을 가리킨다", () => {
    const w = open();
    const before = w.state().factions.faction_a!.resources.ammo ?? 0;
    resolveWith(w, [{ faction_resource: { faction: "zone_owner", resource: "ammo", delta: 3 } }]);
    expect(w.state().factions.faction_a!.resources.ammo).toBe(before + 3);
  });
});

describe("남겨 둔 사람 (recall + here)", () => {
  it("이름표로 기억한 사람이 그 구역에 있을 때만 다시 부른다", async () => {
    const { eligibleStorylets } = await import("../story/storylets.ts");
    const w = open();
    const keepIt = parse({ id: "k", title: "k", cast: { p: { extra: "refugee", keep: "left_one" } }, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const again = parse({ id: "again", title: "again", cast: { p: { recall: "left_one", here: true } }, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const content = { ...w.content, storylets: { again } };
    fireStorylet({ ...w.ctx(), content: { ...w.content, storylets: { k: keepIt } } }, keepIt, { p: "@extra:refugee" });
    expect(eligibleStorylets(w.state(), content).map((s) => s.id)).toEqual(["again"]);
    w.ctx().store.append({ type: "storylet_expired", storyletId: "k" });
    go(w, "old_town");
    expect(eligibleStorylets(w.state(), content).map((s) => s.id)).toEqual([]);
  });
});
