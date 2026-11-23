import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickDailyOffers } from "../game/missions.ts";
import { moveOf } from "../scenario/scenario.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { missionPlace } from "./missionTools.ts";

/** 설계 목록 임무·보고 (12-284). 실제 콘텐츠로 본다 */
const content = { ...loadRealContent(), storylets: {} };
const make = (role: string) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-284-")), content, rngFactory: () => () => 0.99 }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
type W = ReturnType<typeof make>;
const checkAct = (move: string) => ({ intent: "임무", check: { move, stat: moveOf(content.scenario, move)!.stats[0], difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: true, ignore_story: true });
const take = (w: W, template: string, giver: string) => {
  w.ctx().store.append({ type: "missions_offered", day: 1, templateIds: [template] });
  w.executeTool("npc_presence", { npc_id: giver, action: "enter" });
  const r = w.executeTool("assign_mission", { template_id: template });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
};

describe("임무·보고 (12-284)", () => {
  it("손으로 하는 일은 혼자 해도 그 몫이 무리 창고에 든다 (5-1)", () => {
    const w = make("role_y_islander");
    take(w, "y_net_haul", "y_gangho");
    const food = w.state().factions.faction_y!.resources.food!;
    const t = w.state().time;
    w.ctx().store.append({ type: "time_advanced", activity: "work", from: t, to: t + 180 });
    w.executeTool("take_action", checkAct("athletics"));
    w.executeTool("npc_presence", { npc_id: "y_gangho", action: "enter" });
    const out = w.executeTool("report_mission", {});
    expect(out.ok ? out.resultText : out.error).toContain("주인공이 한 일의 몫");
    expect(w.state().factions.faction_y!.resources.food!).toBeGreaterThan(food);
  });

  it("보정이 음수인 판정이 든 일감은 다른 후보가 있으면 뒤로 미룬다 (5-3)", () => {
    const pool = content.roles.role_y_islander!.missions;
    const weak = (m: string) => m === "athletics";
    const hasWeak = (id: string) => content.missions[id]!.requirements.some((r) => "check" in r && weak(r.check));
    expect(pool.some(hasWeak)).toBe(true);
    for (let i = 0; i < 20; i++) {
      let n = i;
      const rng = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
      const offers = pickDailyOffers(content, "role_y_islander", 600, null, rng, [], false, undefined, undefined, undefined, [], false, weak)!;
      expect(offers.templateIds.some(hasWeak)).toBe(false);
    }
  });

  it("임무 자리는 구역 목록도 받는다 (5-4)", () => {
    expect(content.missions.market_errand!.where).toEqual(["riverside", "e_market"]);
    const w = make("role_a_grunt");
    const place = missionPlace(w.state(), content, ["riverside", "e_market"], "faction_a");
    expect(place?.zones).toEqual(["riverside", "e_market"]);
  });

  it("알게 되는 것은 조건을 다 채운 현장에서 나온다 (5-5)", () => {
    const w = make("role_a_squad_leader");
    take(w, "a_sl_find_straggler", "a_doyun");
    w.runCheat("~goto old_town");
    w.executeTool("take_action", checkAct("survival"));
    const second = w.executeTool("take_action", checkAct("sense_danger"));
    expect(second.ok ? second.resultText : second.error).toContain("임무 현장에서");
    expect(w.state().beliefs[w.state().playerId]!.some((b) => b.fact === content.missions.a_sl_find_straggler!.learns)).toBe(true);
  });

  it("몸값을 갚겠다는 다짐에 공적 감점이 없고, 하얀매 수비대원의 직분은 의무다 (5-6·5-7)", () => {
    const thank = loadRealContent().storylets.cp_long_ransom!.choices.find((c) => c.id === "thank")!;
    expect(thank.effects.some((e) => "merit" in e)).toBe(false);
    expect(content.roles.role_d_medic!.occupation).toBe("medic");
  });
});
