import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { buildCustomRole } from "../game/customStart.ts";
import { createSeededRng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { WorldManager } from "../world/manager.ts";
import { runNpcRecovery } from "./body.ts";
import { executeTool } from "./tools.ts";

/** NPC도 낫는다 (12-52) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-care-")), content, rngFactory: () => createSeededRng(2) });
const hurt = (w: ReturnType<WorldManager["create"]>, id: string, to: string, track = "harm") =>
  w.ctx().store.append({ type: "condition_changed", targetId: id, track, from: w.state().characters[id]!.conditions[track]!, to, fatal: false, by: "test", cause: "test", day: 1, harmTrack: track === "harm" });
const later = (w: ReturnType<WorldManager["create"]>, days: number) => w.ctx().store.append({ type: "time_advanced", minutes: days * MINUTES_PER_DAY } as never);

describe("NPC의 회복", () => {
  it("저절로 낫는다 (새 부상 없이 이틀), 붙잡힌 사람은 낫지 않는다", () => {
    const w = manager().create("mcp", "role_a_grunt");
    hurt(w, "a_jiho", "light");
    hurt(w, "a_gicheol_scout", "light"); // 처음부터 붙잡혀 있다
    w.ctx().store.getState().time += 3 * MINUTES_PER_DAY;
    runNpcRecovery({ ...w.ctx(), content: { ...w.content, factions: {} } as never });
    expect(w.state().characters.a_jiho!.conditions.harm).toBe("none");
    expect(w.state().characters.a_gicheol_scout!.conditions.harm).toBe("light");
  });

  it("무리 의무실이 의약품을 써서 크게 다친 사람과 드러난 감염을 돌본다", () => {
    const w = manager().create("mcp", "role_a_grunt");
    hurt(w, "a_mansu", "critical");
    hurt(w, "a_seoyeon", "fever", "infection");
    const med = () => w.state().factions.faction_a!.resources.medicine ?? 0;
    const before = med();
    runNpcRecovery(w.ctx());
    expect(w.state().characters.a_mansu!.conditions.harm).toBe("serious");
    expect(w.state().characters.a_seoyeon!.conditions.infection).toBe("clean");
    expect(med()).toBe(before - 3);
  });
});

describe("주인공이 남을 치료한다", () => {
  const medic = { faction: "faction_a", rank: "staff", occupation: "medic", title: "의무병", location: "a_base", kit: "trader", skills: {}, age: 30, opening: "x", background: [] };
  it("의무병은 아이템 없이 장면의 다친 사람을 하루 한 번 돌보고, 아니면 아이템이 있어야 한다", () => {
    const w = manager().create("mcp", undefined, undefined, undefined, { role: buildCustomRole(content, medic), background: [] });
    w.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    hurt(w, "a_jiho", "serious");
    const treat = (item: string | null) => w.executeTool("take_action", { intent: "치료", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, treatment: { item, target: "a_jiho" } });
    expect(treat(null).ok).toBe(true);
    expect(w.state().characters.a_jiho!.conditions.harm).toBe("light");
    const again = treat(null);
    expect(again.ok && again.resultText).toContain("오늘 이미");
    const grunt = manager().create("mcp", "role_a_grunt");
    grunt.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    hurt(grunt, "a_jiho", "light");
    const no = grunt.executeTool("take_action", { intent: "치료", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, treatment: { item: null, target: "a_jiho" } });
    expect(no.ok && no.resultText).toContain("돌볼 줄 모른다");
    grunt.ctx().store.append({ type: "item_granted", to: "player", itemId: "bandage", quantity: 1 });
    const yes = grunt.executeTool("take_action", { intent: "치료", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, treatment: { item: "bandage", target: "a_jiho" } });
    expect(yes.ok).toBe(true);
    expect(grunt.state().characters.a_jiho!.conditions.harm).toBe("none");
  });
});
