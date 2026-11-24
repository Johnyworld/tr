import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeRequest, offeredQuests, questOf, type Quest } from "../rules/request.ts";
import { whereIs } from "../rules/place.ts";
import { isCreature } from "../game/kinds.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { enterScene } from "./extras.ts";
import type { ToolOutcome } from "./toolkit.ts";

/** PT25 뒤 고친 것 (12-293). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role = "role_a_grunt", roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-293-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);
type W = ReturnType<typeof make>;
const text = (r: ToolOutcome) => (r.ok ? r.resultText : r.error);
const ok = (r: ToolOutcome) => expect(r.ok ? null : r.error).toBeNull();

function giverHere(w: W): string {
  const s = w.state();
  const id = Object.values(content.npcs).find((n) => n.faction === s.characters[s.playerId]!.factionId && n.id !== s.playerId && whereIs(s, content, n.id)?.zone === s.playerZone && !s.characters[n.id]?.dead)!.id;
  w.executeTool("npc_presence", { npc_id: id, action: "enter" });
  return id;
}

function offer(w: W, giver: string, quest: Omit<Quest, "target" | "hops" | "pay" | "delivered" | "days">): string {
  const s = w.state();
  const id = `p_${(s.promises ?? []).length + 1}`;
  w.ctx().store.append({ type: "request_offered", id, by: s.playerId, to: giver, what: "시험 의뢰", due: Math.floor(s.time / 1440) + 1, item: null, quest: { ...quest, target: null, hops: 1, delivered: 0, days: 3, pay: { id: "canned_food", quantity: 2 } } });
  return id;
}

describe("PT25 뒤 고친 것 (12-293)", () => {
  it("사람 찾기를 받는 글에 틀 문자열이 남지 않고, 기한은 내놓을 때 정한 날수 그대로다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = Object.keys(content.locations).find((z) => !w.state().zones[z]?.owner && content.locations[z]!.places.some((p) => !p.road))!;
    const id = offer(w, giver, { kind: "find", template: "missing_person", zone, place: null });
    const r = w.executeTool("request", { action: "accept", request_id: id });
    ok(r);
    expect(text(r)).not.toContain("${");
    expect(text(r)).toContain(`보수 +${content.scenario.requests!.reward.brought}`);
    expect(text(r)).toContain("3일 안에");
  });

  it("의뢰인 무리 땅이 아닌 곳에서 붙잡아 오기를 보고하면 포로는 그대로 끌고 다닌다", () => {
    const w = make();
    const giver = giverHere(w);
    const wild = Object.keys(content.locations).find((z) => !w.state().zones[z]?.owner && z !== w.state().playerZone)!;
    const id = offer(w, giver, { kind: "capture", template: "outlaw", zone: wild, place: null });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const outlaw = questOf(activeRequest(w.state()))!.target!;
    // 의뢰인과 함께 빈 땅으로 가서 묶었다고 치고 그 자리에서 보고한다
    w.ctx().store.append({ type: "companion_joined", characterId: giver });
    w.executeTool("take_action", { intent: "간다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, move_to: wild, with: [giver] });
    if (w.state().playerZone !== wild) return; // 길이 닿지 않으면 볼 것이 없다
    enterScene(w.ctx(), outlaw);
    w.ctx().store.append({ type: "companion_joined", characterId: outlaw, kind: "prisoner" });
    ok(w.executeTool("request", { action: "report" }));
    expect(w.state().characters[outlaw]!.captive).toBeNull();
    expect(w.state().companions).toContain(outlaw);
  });

  it("숨어서 위협이 지나갔다는 결과면 감염체 배역이 장면을 떠난다", () => {
    const w = make();
    const fired = w.runCheat("~storylet wg_gunshot_wave");
    if (!fired.ok) return; // 이 자리에서 열 수 없으면 볼 것이 없다
    const before = w.state().scene.present.filter((id) => isCreature(content, w.state().characters[id]!));
    expect(before.length).toBeGreaterThan(0);
    ok(w.executeTool("resolve_storylet", { choice_id: "hide" }));
    for (const id of before) expect(w.state().scene.present).not.toContain(id);
  });

  it("찾아오기는 사물함에 이미 있는 물건을 고르지 않는다", () => {
    for (const roll of [0.1, 0.4, 0.7, 0.95]) {
      const w = make("role_y_islander", roll);
      const giver = giverHere(w);
      w.executeTool("request", { action: "ask", npc_id: giver });
      const stash = Object.values(w.state().stashes?.[w.state().playerId] ?? {});
      for (const p of offeredQuests(w.state())) if (p.item) expect(stash.some((items) => (items[p.item!.id] ?? 0) > 0)).toBe(false);
    }
  });
});
