import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

describe("빚 (기획서 9.10)", () => {
  it("짐꾼은 상단에 빚을 지고 시작하고, 상태와 GM에 보이며, 빚이 쌓이면 독촉 이야기가 열린다", async () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-debt-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_e_porter");
    expect(w.state().characters.player!.debts).toEqual({ faction_e: 12 });
    expect(await w.runCommand("?상태")).toContain("빚    나루상단 12");
    expect(w.sceneForGm()).toContain("빚 (장부에 적힌 양): 나루상단 12");
    const s = w.state();
    const later = s.time + 6 * 1440 + 6 * 60;
    expect(eligibleStorylets(s, w.content, later).map((x) => x.id)).toContain("wd_dunning");
    // 빚은 0 아래로 내려가지 않는다
    w.ctx().store.append({ type: "debt_changed", characterId: "player", factionId: "faction_e", delta: -50 });
    expect(w.state().characters.player!.debts).toEqual({});
    expect(eligibleStorylets(w.state(), w.content, later).map((x) => x.id)).not.toContain("wd_dunning");
    w.close();
  });

  it("빚 갚는 일감을 완수하면 장부에서 준다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-debt-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_e_porter");
    const boss = w.content.roles.role_e_porter!.commander!;
    w.executeTool("npc_presence", { npc_id: boss, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["e_water_haul"] });
    expect(w.executeTool("assign_mission", { template_id: "e_water_haul" }).ok).toBe(true);
    w.executeTool("take_action", act("물을 나른다", { activity: { kind: "work", until: null }, for_mission: true }));
    // 판정은 주사위에 맡기지 않고 기록으로 넣는다 (버티기 대가 있는 성공 이상)
    for (let i = 0; i < 6; i++) {
      const r = w.executeTool("take_action", act("물통을 진다", { check: { move: "endure", stat: "vitality", difficulty: "very_easy", harm_on_failure: "none", harm_cause: "" }, for_mission: true }));
      if (r.ok && r.outcome !== "miss") break;
    }
    if (!w.state().scene.present.includes(boss)) w.executeTool("npc_presence", { npc_id: boss, action: "enter" });
    const out = w.executeTool("report_mission", {});
    expect(out.ok).toBe(true);
    expect(w.state().characters.player!.debts.faction_e ?? 0).toBeLessThan(12);
    if (out.ok) expect(out.resultText).toContain("빚을 갚았다");
    w.close();
  });
});
