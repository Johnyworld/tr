import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCustomRole } from "../game/customStart.ts";
import { createSeededRng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { WorldManager } from "../world/manager.ts";
import { runNpcRecovery } from "./body.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent, teachSkills } from "../testing.ts";

/** NPC도 낫는다 (12-52) */
const content = loadRealContent();
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

  it("무리 의무실이 의약품을 써서 크게 다친 사람을 돌본다. 감염은 떼지 못한다 (혈청뿐, 12-106)", () => {
    const w = manager().create("mcp", "role_a_grunt");
    hurt(w, "a_mansu", "critical");
    hurt(w, "a_seoyeon", "fever", "infection");
    const med = () => w.state().factions.faction_a!.resources.medicine ?? 0;
    const before = med();
    runNpcRecovery(w.ctx());
    expect(w.state().characters.a_mansu!.conditions.harm).toBe("serious");
    expect(w.state().characters.a_seoyeon!.conditions.infection).toBe("fever");
    expect(med()).toBe(before - 1);
  });
});

describe("주인공이 남을 치료한다", () => {
  const medic = { faction: "faction_a", rank: "staff", occupation: "medic", title: "의무병", location: "a_base", kit: "trader", skills: {}, age: 30, opening: "x", background: [] };
  it("응급처치: 의무병은 아이템 없이, 아니면 아이템이 있어야 상처를 돌본다. 판정 성공이면 한 단계, 하루 한 번", () => {
    const six = () => () => 0.99;
    const mk = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-care-")), content, rngFactory: six });
    const w = mk().create("mcp", undefined, undefined, undefined, { role: buildCustomRole(content, medic), background: [] });
    // 응급처치는 전문 기술이라 둘 다 배워 둔다 (4.2.1). 의무병과 아닌 사람의 차이는 아이템이다
    teachSkills(w, ["first_aid"]);
    w.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    hurt(w, "a_jiho", "serious");
    const aid = { move: "first_aid", stat: "intellect", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, opponent: null, distance: null, infected_source: false, target_harm: "none" };
    const treat = (wm: typeof w, item: string | null) => wm.executeTool("take_action", { intent: "치료", check: aid, treatment: { item, target: "a_jiho" } });
    const first = treat(w, null);
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    expect(w.state().characters.a_jiho!.conditions.harm).toBe("light");
    const again = treat(w, null);
    expect(!again.ok && again.error).toContain("오늘 이미 돌봤다");
    const grunt = mk().create("mcp", "role_a_grunt");
    teachSkills(grunt, ["first_aid"]);
    grunt.executeTool("npc_presence", { npc_id: "a_jiho", action: "enter" });
    hurt(grunt, "a_jiho", "light");
    const no = treat(grunt, null);
    expect(!no.ok && no.error).toContain("구급상자");
    grunt.ctx().store.append({ type: "item_granted", to: "player", itemId: "medkit", quantity: 1 });
    const yes = treat(grunt, "medkit");
    expect(yes.ok, yes.ok ? "" : yes.error).toBe(true);
    expect(grunt.state().characters.a_jiho!.conditions.harm).toBe("none");
  });
});
