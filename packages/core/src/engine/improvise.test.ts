import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentSchemas } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { fireStorylet } from "./storyletTools.ts";
import { executeTool } from "./tools.ts";

/** 이야기를 즉흥으로 풀기 (12-145): 선택지에 없는 방법이라도 결과의 성격이 같으면 그 선택지로, 판정 스킬은 플레이어의 방법대로 */
const content = loadRealContent();
const parse = createContentSchemas(content.scenario).storylet.parse;
const story = parse({
  id: "t145",
  title: "t",
  setup: "x",
  choices: [{ id: "run", label: "달아난다", check: "stealth", outcomes: { success: [{ set_flag: "t145_ok" }], partial: [{ set_flag: "t145_ok" }], miss: [{ set_flag: "t145_miss" }] } }],
});
const open = () => {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-imp-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", "role_a_grunt");
  const ctx = { ...w.ctx(), content: { ...w.content, storylets: { ...w.content.storylets, t145: story } } };
  fireStorylet(ctx, story, {});
  const check = (move: string) =>
    executeTool("take_action", { intent: "쓰레기통을 걷어차 소리를 나누고 빠진다", check: { move, stat: "intellect", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false }, ctx);
  return { w, ctx, check };
};

describe("이야기를 즉흥으로 풀기", () => {
  it("다른 스킬로 판정하고 improvised_move에 적으면 그 선택지의 결과를 따른다", () => {
    const { w, ctx, check } = open();
    check("improvise");
    const out = executeTool("resolve_storylet", { choice_id: "run", improvised_move: "improvise" }, ctx);
    expect(out.ok && out.resultText).toContain("즉흥으로 풀었다");
    const flags = w.state().flags[w.state().playerId] ?? [];
    expect(flags.includes("t145_ok") || flags.includes("t145_miss")).toBe(true);
  });

  it("적은 스킬로 판정하지 않았으면 거절하고, 적지 않으면 선택지의 스킬 판정이 필요하다", () => {
    const { ctx, check } = open();
    expect(executeTool("resolve_storylet", { choice_id: "run", improvised_move: "improvise" }, ctx).ok).toBe(false);
    check("improvise");
    const plain = executeTool("resolve_storylet", { choice_id: "run" }, ctx);
    expect(plain.ok ? "" : plain.error).toContain("은밀");
  });
});
