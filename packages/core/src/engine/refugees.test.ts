import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentSchemas } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 피난민 (12-133): 무리의 사람 수가 바뀌면 입과 손이 함께 바뀐다 */
const base = loadRealContent();
const parse = createContentSchemas(base.scenario).storylet.parse;
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-rf-")), content: base, rngFactory: () => createSeededRng(3) }).create("mcp", "role_a_grunt");
const resolveWith = (w: ReturnType<typeof open>, effects: unknown[]) => {
  const s = parse({ id: "t133", title: "t", setup: "x", choices: [{ id: "a", label: "a", effects }] });
  const ctx = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, t133: s } } };
  fireStorylet(ctx, s, {});
  return executeTool("resolve_storylet", { choice_id: "a" }, ctx);
};

describe("피난민", () => {
  it("받아들이면 우리 무리의 사람 수가 늘고, 떠나면 줄며 싸울 사람도 그 안으로 준다", () => {
    const w = open();
    const f = () => w.state().factions.faction_a!;
    const pop = f().population;
    expect(resolveWith(w, [{ faction_population: { faction: "own", delta: 7 } }]).ok).toBe(true);
    expect(f().population).toBe(pop + 7);
    f().combatants = f().population;
    resolveWith(w, [{ faction_population: { faction: "own", delta: -10 } }]);
    expect(f().population).toBe(pop - 3);
    expect(f().combatants).toBe(f().population);
  });

  it("사람이 늘면 전쟁 틱의 하루 식량 소모가 는다", () => {
    const world = initialWarWorld(base);
    const more = structuredClone(world);
    more.factions.faction_a!.population += 20;
    const food = (wd: typeof world) => simulateWarDay(wd, base, createSeededRng(1)).factions.faction_a!.resources.food!;
    expect(food(more)).toBeLessThan(food(world));
  });
});
