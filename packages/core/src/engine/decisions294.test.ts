import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offeredQuests, questOf, type Quest } from "../rules/request.ts";
import { whereIs, whereLabel } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { enterScene } from "./extras.ts";
import type { ToolOutcome } from "./toolkit.ts";

/** PT26 뒤 고친 것 (12-294). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role = "role_a_grunt", roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-294-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);
type W = ReturnType<typeof make>;
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

describe("PT26 뒤 고친 것 (12-294)", () => {
  it("섬의 찾아오기는 수색표에서 흔한 물건만 고른다", () => {
    const min = content.scenario.requests!.kinds.fetch.min_share;
    for (const roll of [0.05, 0.3, 0.6, 0.95]) {
      const w = make("role_y_islander", roll);
      const giver = giverHere(w);
      w.executeTool("request", { action: "ask", npc_id: giver });
      for (const p of offeredQuests(w.state())) {
        if (!p.item) continue;
        const table = content.locations[questOf(p)!.zone]!.loot!.items;
        const total = table.reduce((n, i) => n + i.weight, 0);
        expect(table.find((i) => i.item === p.item!.id)!.weight / total).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("의뢰인 땅이 아닌 곳에서 데려온 사람을 보고하면 순간이동하지 않고 데려온 보수도 없다", () => {
    const w = make();
    const giver = giverHere(w);
    const wild = Object.keys(content.locations).find((z) => !w.state().zones[z]?.owner && z !== w.state().playerZone)!;
    const id = offer(w, giver, { kind: "find", template: "missing_person", zone: wild, place: null });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const target = questOf(w.state().promises.find((p) => p.id === id))!.target!;
    w.ctx().store.append({ type: "companion_joined", characterId: giver });
    w.executeTool("take_action", { intent: "간다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, move_to: wild, with: [giver] });
    if (w.state().playerZone !== wild) return;
    enterScene(w.ctx(), target);
    const food = w.state().characters[w.state().playerId]!.inventory.canned_food ?? 0;
    // 길에서 연 이야기는 먼저 닫는다 (12-299: 이야기가 열려 있으면 의뢰 보고는 이야기부터)
    const open = w.state().activeStorylet;
    if (open) w.ctx().store.append({ type: "storylet_expired", storyletId: open.id });
    ok(w.executeTool("request", { action: "report" }));
    expect(w.state().characters[target]!.extra!.zone).toBe(wild);
    expect(w.state().characters[w.state().playerId]!.inventory.canned_food).toBe(food + 2);
  });

  it("이름도 모르고 만난 적 없는 사람의 행방은 알려 주지 않는다", () => {
    const w = make();
    const s = w.state();
    const stranger = Object.values(content.npcs).find((n) => !(s.met[s.playerId] ?? []).includes(n.id) && !(s.known[s.playerId] ?? []).includes(n.id) && !!whereIs(s, content, n.id)?.zone)!;
    expect(whereLabel(s, content, stranger.id)).toBeNull();
  });

});
