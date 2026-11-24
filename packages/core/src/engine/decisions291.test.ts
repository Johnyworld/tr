import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GameState } from "../game/state.ts";
import { activeRequest, offeredQuests, type Quest } from "../rules/request.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { enterScene } from "./extras.ts";
import { runPromisesDaily } from "./promises.ts";
import type { ToolOutcome } from "./toolkit.ts";

const text = (r: ToolOutcome) => (r.ok ? r.resultText : r.error);

/** 의뢰 (12-291). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = (role = "role_a_grunt", roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-291-")), content, rngFactory: () => () => roll }).create("mcp", role, { name: "하람", gender: "female", abilities: null, portrait: null, traits: [], past: "farmer" } as never);
type W = ReturnType<typeof make>;

/** 지금 구역에 있는 같은 무리 사람 하나를 장면에 들인다 */
function giverHere(w: W): string {
  const s = w.state();
  const id = Object.values(content.npcs).find((n) => n.faction === s.characters[s.playerId]!.factionId && n.id !== s.playerId && whereIs(s, content, n.id)?.zone === s.playerZone && !s.characters[n.id]?.dead)!.id;
  w.executeTool("npc_presence", { npc_id: id, action: "enter" });
  return id;
}

/** 정해 둔 종류의 의뢰를 내놓게 한다 (종류는 굴림이라 테스트에서 고정) */
function offer(w: W, giver: string, quest: Omit<Quest, "target" | "hops" | "pay"> & { pay?: Quest["pay"] }, item: { id: string; quantity: number } | null = null): string {
  const s = w.state();
  const id = `p_${(s.promises ?? []).length + 1}`;
  w.ctx().store.append({ type: "request_offered", id, by: s.playerId, to: giver, what: "시험 의뢰", due: Math.floor(s.time / 1440) + 1, item, quest: { ...quest, target: null, hops: 1, pay: quest.pay ?? { id: "canned_food", quantity: 2 } } });
  return id;
}

const ok = (r: ToolOutcome) => {
  expect(r.ok ? null : r.error).toBeNull();
  expect(r.ok).toBe(true);
};
const killed = (w: W, id: string) => {
  const s: GameState = w.state();
  const track = content.scenario.harm_track;
  const last = content.scenario.condition_tracks.find((t) => t.id === track)!.levels.at(-1)!.id;
  w.ctx().store.append({ type: "condition_changed", targetId: id, track, from: s.characters[id]!.conditions[track]!, to: last, fatal: true, by: s.playerId, cause: "시험", day: Math.floor(s.time / 1440), harmTrack: true });
};

describe("의뢰 (12-291)", () => {
  it("장면의 인물에게 물으면 그 사람이 줄 만한 의뢰가 나오고, 한 번에 하나만 받는다", () => {
    const w = make();
    const giver = giverHere(w);
    const asked = w.executeTool("request", { action: "ask", npc_id: giver });
    ok(asked);
    const p = offeredQuests(w.state(), giver)[0]!;
    expect(p).toBeTruthy();
    expect(text(asked)).toContain(p.id);
    // 다시 물으면 같은 의뢰
    expect(text(w.executeTool("request", { action: "ask", npc_id: giver }))).toContain(p.id);
    ok(w.executeTool("request", { action: "accept", request_id: p.id }));
    expect(activeRequest(w.state())?.id).toBe(p.id);
    // 진행 중인 의뢰가 있으면 더 묻지 못한다
    const again = w.executeTool("request", { action: "ask", npc_id: giver });
    expect(again.ok).toBe(false);
    expect(text(again)).toContain("한 번에 하나");
  });

  it("사람 찾기: 받으면 목표가 그 장소에 생기고 아직 만나지 않았다. 찾아 만나면 보고해 보수를 받는다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = w.state().playerZone!;
    const place = content.locations[zone]!.places.find((p) => !p.road && !p.jail)!.id;
    const id = offer(w, giver, { kind: "find", template: "missing_person", zone, place });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const target = activeRequest(w.state())!;
    const t = Object.values(w.state().characters).find((c) => c.extra?.template === "missing_person")!;
    expect(t.extra!.zone).toBe(zone);
    expect(t.extra!.place).toBe(place);
    expect(w.state().met[w.state().playerId] ?? []).not.toContain(t.id);
    // 아직 못 찾았으면 보고가 막힌다
    expect(w.executeTool("request", { action: "report", request_id: target.id }).ok).toBe(false);
    enterScene(w.ctx(), t.id);
    const food = w.state().characters[w.state().playerId]!.inventory.canned_food ?? 0;
    const done = w.executeTool("request", { action: "report", request_id: target.id });
    ok(done);
    // 곁에 데려왔으니 보수 +1, 그리고 의뢰인 곁에 머문다
    expect(w.state().characters[w.state().playerId]!.inventory.canned_food).toBe(food + 3);
    expect(w.state().characters[t.id]!.extra!.zone).toBe(whereIs(w.state(), content, giver)!.zone);
    expect(activeRequest(w.state())).toBeNull();
  });

  it("처치하기: 목표가 죽어야 해내고, 붙잡아 오기는 죽이면 해내지 못한다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = w.state().playerZone!;
    const id = offer(w, giver, { kind: "kill", template: "feral_dog", zone, place: null });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const dog = Object.values(w.state().characters).find((c) => c.extra?.template === "feral_dog")!.id;
    expect(w.executeTool("request", { action: "report" }).ok).toBe(false);
    killed(w, dog);
    ok(w.executeTool("request", { action: "report" }));

    const id2 = offer(w, giver, { kind: "capture", template: "outlaw", zone, place: null });
    ok(w.executeTool("request", { action: "accept", request_id: id2 }));
    const outlaw = Object.values(w.state().characters).find((c) => c.extra?.template === "outlaw")!.id;
    killed(w, outlaw);
    const r = w.executeTool("request", { action: "report" });
    expect(r.ok).toBe(false);
    expect(text(r)).toContain("산 채로");
  });

  it("붙잡아 오기: 묶어 끌고 온 사람을 의뢰인이 넘겨받는다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = w.state().playerZone!;
    const id = offer(w, giver, { kind: "capture", template: "outlaw", zone, place: null });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    const outlaw = Object.values(w.state().characters).find((c) => c.extra?.template === "outlaw")!.id;
    enterScene(w.ctx(), outlaw);
    w.ctx().store.append({ type: "companion_joined", characterId: outlaw, kind: "prisoner" });
    ok(w.executeTool("request", { action: "report" }));
    expect(w.state().characters[outlaw]!.captive?.by).toBe(w.state().characters[giver]!.factionId);
    expect(w.state().companions).not.toContain(outlaw);
  });

  it("찾아오기: 그 물건을 건네면 해내고, 기한을 넘기면 의뢰인 신뢰가 requests.failed만큼 깎인다", () => {
    const w = make();
    const giver = giverHere(w);
    const zone = w.state().playerZone!;
    const id = offer(w, giver, { kind: "fetch", template: null, zone, place: null }, { id: "bandage", quantity: 1 });
    ok(w.executeTool("request", { action: "accept", request_id: id }));
    w.ctx().store.append({ type: "item_granted", to: w.state().playerId, itemId: "bandage", quantity: 1 });
    ok(w.executeTool("transfer_item", { from: w.state().playerId, to: giver, item_id: "bandage", quantity: 1 }));
    expect(activeRequest(w.state())).toBeNull();

    const id2 = offer(w, giver, { kind: "fetch", template: null, zone, place: null }, { id: "bandage", quantity: 1 });
    ok(w.executeTool("request", { action: "accept", request_id: id2 }));
    const before = w.state().relations[giver]?.[w.state().playerId]?.trust ?? 0;
    const p = activeRequest(w.state())!;
    const t = w.state().time;
    w.ctx().store.append({ type: "time_advanced", activity: "wait", from: t, to: (p.due + 1) * 1440 + 60 });
    runPromisesDaily(w.ctx());
    expect(w.state().promises.find((x) => x.id === id2)!.status).toBe("broken");
    expect(w.state().relations[giver]?.[w.state().playerId]?.trust ?? 0).toBe(before + content.scenario.requests!.failed.trust);
  });

  it("인물이 먼저 꺼낸 부탁을 받았으면 그것도 진행 중인 의뢰로 센다", () => {
    const w = make();
    const giver = giverHere(w);
    const s = w.state();
    w.ctx().store.append({ type: "promise_asked", id: `p_${s.promises.length + 1}`, by: s.playerId, to: giver, what: "부탁", due: Math.floor(s.time / 1440) + 3, item: { id: "bandage", quantity: 1 }, favor: "x" });
    w.ctx().store.append({ type: "promise_accepted", id: `p_${s.promises.length + 1}`, what: "부탁", due: Math.floor(s.time / 1440) + 3, item: { id: "bandage", quantity: 1 } });
    expect(activeRequest(w.state())).toBeTruthy();
    expect(w.executeTool("request", { action: "ask", npc_id: giver }).ok).toBe(false);
  });

  it("목표 장소를 모르면 이름 대신 어림으로 알린다", () => {
    const w = make();
    const giver = giverHere(w);
    // 가 보지 않은 다른 구역의 장소
    const s = w.state();
    const mine = s.characters[s.playerId]!.factionId;
    const zone = Object.keys(content.locations).find((z) => z !== s.playerZone && s.zones[z]?.owner !== mine && !(s.knownPlaces?.[s.playerId] ?? []).some((k) => k.startsWith(`${z}:`)) && content.locations[z]!.places.some((p) => !p.road && !p.gate))!;
    const place = content.locations[zone]!.places.find((p) => !p.road && !p.gate)!;
    const id = offer(w, giver, { kind: "find", template: "missing_person", zone, place: place.id });
    const r = w.executeTool("request", { action: "accept", request_id: id });
    ok(r);
    expect(text(r)).toContain(content.locations[zone]!.name);
    expect(text(r)).not.toContain(place.name);
  });
});
