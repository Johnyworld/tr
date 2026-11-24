import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daysServed } from "../game/missions.ts";
import { activeRequest, offeredQuests, questOf, type Quest } from "../rules/request.ts";
import { castHere, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import type { ToolOutcome } from "./toolkit.ts";

/** PT24 뒤 고친 것 (12-292). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role = "role_a_grunt", roll = 0.5, past = "farmer") =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-292-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past } as never);
type W = ReturnType<typeof make>;
const text = (r: ToolOutcome) => (r.ok ? r.resultText : r.error);
const ok = (r: ToolOutcome) => expect(r.ok ? null : r.error).toBeNull();

function giverHere(w: W, pick: (id: string) => boolean = () => true): string {
  const s = w.state();
  const id = Object.values(content.npcs).find((n) => n.faction === s.characters[s.playerId]!.factionId && n.id !== s.playerId && whereIs(s, content, n.id)?.zone === s.playerZone && !s.characters[n.id]?.dead && pick(n.id))!.id;
  w.executeTool("npc_presence", { npc_id: id, action: "enter" });
  return id;
}

function offer(w: W, giver: string, quest: Omit<Quest, "target" | "hops" | "pay" | "delivered" | "days">, item: { id: string; quantity: number } | null = null): string {
  const s = w.state();
  const id = `p_${(s.promises ?? []).length + 1}`;
  w.ctx().store.append({ type: "request_offered", id, by: s.playerId, to: giver, what: "시험 의뢰", due: Math.floor(s.time / 1440) + 1, item, quest: { ...quest, target: null, hops: 1, delivered: 0, days: 0, pay: { id: "canned_food", quantity: 2 } } });
  return id;
}

describe("PT24 뒤 고친 것 (12-292)", () => {
  it("이야기 배역은 같은 장소의 사람만, 찾아오는 배역은 같은 구역에서, 다른 구역은 멀리서 오는 배역만", () => {
    const w = make();
    const s = w.state();
    const zone = s.playerZone!;
    const elsewhere = Object.values(content.npcs).find((n) => { const at = whereIs(s, content, n.id); return at?.zone === zone && !!at.place && at.place !== s.playerPlace && !s.scene.present.includes(n.id); });
    const away = Object.values(content.npcs).find((n) => { const at = whereIs(s, content, n.id); return !!at?.zone && at.zone !== zone; })!;
    if (elsewhere && s.playerPlace) {
      expect(castHere(s, content, elsewhere.id, false, true)).toBe(false);
      expect(castHere(s, content, elsewhere.id, true, true)).toBe(true);
      expect(castHere(s, content, elsewhere.id, true, false)).toBe(false);
    }
    expect(castHere(s, content, away.id, true, true)).toBe(false);
    expect(castHere(s, content, away.id, "afar", true)).toBe(true);
  });

  it("받은 의뢰를 그만두면 신뢰가 깎이고 곧바로 다른 의뢰를 물을 수 있다", () => {
    const w = make();
    const giver = giverHere(w);
    const id = offer(w, giver, { kind: "fetch", template: null, zone: w.state().playerZone!, place: null }, { id: "bandage", quantity: 1 });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const asked = w.executeTool("request", { action: "ask", npc_id: giver });
    expect(text(asked)).toContain("request abandon");
    const before = w.state().relations[giver]?.[w.state().playerId]?.trust ?? 0;
    ok(w.executeTool("request", { action: "abandon" }));
    expect(activeRequest(w.state())).toBeNull();
    expect(w.state().relations[giver]?.[w.state().playerId]?.trust ?? 0).toBe(before + content.scenario.requests!.failed.trust);
    // 받을 때의 믿음은 내려놓는다
    expect((w.state().beliefs[w.state().playerId] ?? []).some((b) => b.topic === `request:${id}`)).toBe(false);
  });

  it("찾아오기는 나눠 건네도 센다", () => {
    const w = make();
    const giver = giverHere(w);
    const id = offer(w, giver, { kind: "fetch", template: null, zone: w.state().playerZone!, place: null }, { id: "canned_food", quantity: 2 });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const me = w.state().playerId;
    w.ctx().store.append({ type: "item_granted", to: me, itemId: "canned_food", quantity: 2 });
    expect(text(w.executeTool("transfer_item", { from: me, to: giver, item_id: "canned_food", quantity: 1 }))).toContain("1/2");
    expect(activeRequest(w.state())?.id).toBe(id);
    ok(w.executeTool("transfer_item", { from: me, to: giver, item_id: "canned_food", quantity: 1 }));
    expect(activeRequest(w.state())).toBeNull();
  });

  it("다른 장소에 둔 의뢰 목표는 불러들이지 못하고, 만나기 전에는 GM 상태에 뜨지 않는다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = w.state().playerZone!;
    const place = content.locations[zone]!.places.find((p) => !p.road && !p.jail && p.id !== w.state().playerPlace)!.id;
    const id = offer(w, giver, { kind: "find", template: "missing_person", zone, place });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const target = questOf(activeRequest(w.state()))!.target!;
    expect(w.sceneForGm()).not.toContain(`(${target}) 연락이 끊긴 사람`);
    const r = w.executeTool("npc_presence", { npc_id: target, action: "enter" });
    expect(r.ok).toBe(false);
    expect(w.state().scene.present).not.toContain(target);
  });

  it("닫힌 섬에서는 사람·짐승을 두는 의뢰가 나오지 않는다", () => {
    for (const roll of [0.05, 0.3, 0.6, 0.95]) {
      const w = make("role_y_islander", roll);
      const giver = giverHere(w);
      w.executeTool("request", { action: "ask", npc_id: giver });
      for (const p of offeredQuests(w.state())) expect(questOf(p)!.kind).toBe("fetch");
    }
  });

  it("싸울 줄 모르면 싸움 의뢰를 내놓지 않는다", () => {
    const fight = content.scenario.requests!.fight!;
    for (const roll of [0.05, 0.5, 0.95]) {
      const w = make("role_a_grunt", roll);
      const me = w.state().characters[w.state().playerId]!;
      // 이 주인공이 싸울 줄 알면 볼 것이 없다 (졸병 서진처럼 근접전·사격이 서툰 경우만)
      const best = Math.max(...fight.moves.map((m) => { const mv = content.scenario.moves.find((x) => x.id === m)!; return Math.max(...mv.stats.map((st) => me.stats[st] ?? 0)) + (me.skills[m] ?? content.scenario.ranges.skill.min); }));
      if (best >= fight.min) continue;
      const s = w.state();
      const fighter = Object.values(content.npcs).find((n) => n.faction === me.factionId && whereIs(s, content, n.id)?.zone === s.playerZone && fight.moves.some((m) => (s.characters[n.id]?.skills[m] ?? -9) >= 2));
      if (!fighter) continue;
      w.executeTool("npc_presence", { npc_id: fighter.id, action: "enter" });
      w.executeTool("request", { action: "ask", npc_id: fighter.id });
      for (const p of offeredQuests(w.state())) expect(["capture", "kill"]).not.toContain(questOf(p)!.kind);
    }
  });

  it("복무 일수는 날짜로 센다 (진급 줄도)", () => {
    const start = 330;
    expect(daysServed(1440 + 4 * 60, start)).toBe(1);
    expect(daysServed(1440 - 1, start)).toBe(0);
  });

  it("찾는 가족은 다시 만나기 전까지 행방을 모른다", () => {
    const w = make("role_t_visitor", 0.5, "student");
    const fam = w.state().family[0]!;
    const line = w.sceneForGm().split("\n").find((l) => l.includes(`(${fam})`))!;
    expect(line).toContain("행방 모름");
    expect(line).not.toContain("주민");
  });
});
