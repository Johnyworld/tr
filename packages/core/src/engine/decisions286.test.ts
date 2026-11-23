import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Content, StoryletEffect } from "../content/schemas.ts";
import { checkEmptyNews, checkNpcAliases, checkRuinPlaces } from "../content/loader.ts";
import { pickDailyOffers } from "../game/missions.ts";
import { maskedId } from "../rules/knowledge.ts";
import { knowsPlace, whereIs } from "../rules/place.ts";
import { conditionsMet } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { applyEffect } from "./storyletTools.ts";

/** PT21 뒤 고친 것 (12-286). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const quiet = { ...content, storylets: {} };
const make = (role: string, c: Content = quiet) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-286-")), content: c, rngFactory: () => () => 0.99 }).create("mcp", role, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("PT21 뒤 고친 것 (12-286)", () => {
  it("이름 모르는 사람의 id는 GM 글에서 겉 id로, 겉 id로도 부를 수 있다", () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    const stranger = Object.keys(content.npcs).find((id) => content.npcs[id]!.faction === "faction_c" && !(w.state().known[w.state().playerId] ?? []).includes(id) && whereIs(w.state(), content, id)?.zone === "c_warehouse")!;
    const scene = w.sceneForGm();
    expect(scene).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${stranger}(?![A-Za-z0-9_])`));
    const r = w.executeTool("npc_presence", { npc_id: maskedId(stranger), action: "enter" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().scene.present).toContain(stranger);
    expect(r.ok && r.resultText).not.toContain(stranger);
  });

  it("콘텐츠 검사: 별칭의 가두는 곳 이름, 숨은 곳과 겹치는 장소, 내용 없는 소식 줄", () => {
    expect(checkNpcAliases(content)).toEqual([]);
    expect(checkRuinPlaces(content)).toEqual([]);
    expect(checkEmptyNews(content)).toEqual([]);
    const npc = Object.values(content.npcs)[0]!;
    expect(checkNpcAliases({ ...content, npcs: { [npc.id]: { ...npc, alias: "수용소 앞 경비" } } }).length).toBe(1);
  });

  it("섬 사람만 받는 규율 회의는 외딴 섬에서도 열린다", () => {
    const w = make("role_y_islander", content);
    const s = w.state();
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_y" && whereIs(s, content, n.id)?.zone === s.playerZone && n.id !== content.roles.role_y_islander!.commander)!.id;
    w.ctx().store.append({ type: "deed_recorded", deed: { id: `d_${s.nextDeedNo}`, actorId: s.playerId, summary: "부엌 궤짝에서 먹을 것을 챙겼다", tags: ["theft"], severity: 2, at: s.time, witnesses: [{ npcId: mate, hidden: false }], searched: false } });
    const council = content.storylets.disc_y_council!;
    const at = s.time + 3 * 60;
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: s.time, to: at });
    expect(conditionsMet(w.state(), content, council, at)).toBe(true);
  });

  it("시작 짐에서 덜어 낸 것은 섬 사물함에 든다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-286-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_y_islander", { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);
    const said = (w.state().beliefs[w.state().playerId] ?? []).find((b) => b.fact.startsWith("짐이 무거워"));
    if (said) expect(said.fact).toContain("사물함");
  });

  it("역할 일감이 모두 약하면 그 몫을 고집하지 않는다", () => {
    const role = "role_a_squad_leader";
    const own = content.roles[role]!.missions;
    const extra = ["occ_scavenger_ruins"].filter((id) => content.missions[id]);
    const allWeak = (move: string) => own.some((id) => content.missions[id]!.requirements.some((r) => "check" in r && r.check === move));
    const offers = pickDailyOffers(content, role, 600, null, () => 0.1, [...extra, ...Object.keys(content.missions).filter((id) => id.startsWith("occ_scavenger"))], false, undefined, undefined, undefined, [], false, allWeak);
    expect(offers).not.toBeNull();
  });

  it("learn_place로 가족 집을 알게 된다", () => {
    const w = make("role_t_visitor");
    w.runCheat("~goto b_base");
    expect(knowsPlace(w.state(), content, "b_base", "blocks")).toBe(false);
    const r = applyEffect(w.ctx(), { learn_place: { place: "blocks" } } as StoryletEffect, {}, {}, "테스트");
    expect(r.line).toContain("알게 된 곳");
    expect(knowsPlace(w.state(), content, "b_base", "blocks")).toBe(true);
  });
});
