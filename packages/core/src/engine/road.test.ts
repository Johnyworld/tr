import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createContentSchemas } from "../content/schemas.ts";
import { WorldManager } from "../world/manager.ts";

/** 길 위의 일과 피난처 (12-53) */
const base = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const road = createContentSchemas(base.scenario).storylet.parse({
  id: "road_test",
  title: "길 위의 사람",
  tags: ["road"],
  when: { road_touches: ["old_town"] },
  setup: "{from}에서 {to}로 가는 길에 누가 쓰러져 있다.",
  choices: [{ id: "pass", label: "지나간다", effects: [] }],
});
const content = { ...base, storylets: { road_test: road } };
const go = (w: ReturnType<WorldManager["create"]>, to: string) =>
  w.executeTool("take_action", { intent: "이동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, move_to: to });

describe("길 위의 일", () => {
  it("구역을 옮기면 길의 위험만큼 확률로 길 위의 이야기가 열리고, {from} {to}가 채워진다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-road-")), content, rngFactory: () => () => 0 }).create("mcp", "role_a_grunt");
    const out = go(w, "old_town");
    expect(out.ok && out.resultText).toContain("오는 길에 일이 생겼다");
    expect(w.state().activeStorylet?.id).toBe("road_test");
    expect(w.state().lastRoute).toEqual({ from: "a_base", to: "old_town" });
  });

  it("확률을 넘기면 열리지 않고, 길 위의 이야기는 평소에는 열리지 않는다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-road-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
    go(w, "old_town");
    expect(w.state().activeStorylet).toBeNull();
  });
});

describe("미뤄 둔 교전 (12-53에서 찾은 버그)", () => {
  it("그사이 구역 주인이 바뀌어 싸움이 없어져도 교전 기록에 id·at이 섞이지 않는다", async () => {
    const { initialWarWorld, resolveClash } = await import("../sim/war.ts");
    const world = initialWarWorld(base);
    const spec = { id: "pc_1", at: 0, kind: "raid" as const, attacker: "faction_c", defender: "faction_b", zone: "a_base" };
    const { clash } = resolveClash(world, base, () => 0.5, spec as never);
    expect(Object.keys(clash).sort()).toEqual(["attacker", "attackerLosses", "defender", "defenderLosses", "kind", "success", "zone"]);
  });
});
