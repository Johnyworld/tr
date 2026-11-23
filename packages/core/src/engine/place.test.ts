import { routeMinutes, segmentEnd } from "../rules/time.ts";
import { commanderOf } from "../game/missions.ts";
import { describeMissionsForGm } from "./missionTools.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent, atEntry } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { createSeededRng } from "../rng.ts";
import { currentPlace, guardedHere, hereWithMe, jailFor, nearby, npcPlaceAt, placeIndoor, placesIn, shelterAt, storyPlaceFits, whereIs } from "../rules/place.ts";
import { capturePlayer } from "./captivity.ts";
import { campSite } from "./camp.ts";
import { feelsLike } from "./climate.ts";

const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const startWorld = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-place-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", roleId, choice);
// 길(구역에 막 들어온 자리)에서 시작 (12-259 시작 장소 이전의 전제, 장소 개편)
const world = (roleId: string) => atEntry(startWorld(roleId));
const act = (input: Record<string, unknown>) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

describe("구역 안의 장소 (12-244, 공통 규칙 15)", () => {
  it("같은 구역 안의 장소로 5분에 옮기고, 실내외는 그 장소를 따른다", () => {
    const w = world("role_a_grunt");
    expect(w.state().playerZone).toBe("a_base");
    expect(currentPlace(w.state(), content)?.road).toBe(true);
    const t = w.state().time;
    const out = w.executeTool("take_action", act({ intent: "운동장으로 나간다", place_to: "yard_gate" }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(currentPlace(w.state(), content)?.id).toBe("yard_gate");
    expect(w.state().time - t).toBeGreaterThanOrEqual(5);
    expect(placeIndoor(w.state(), content)).toBe(false);
    expect(feelsLike(content, w.state(), "rest")?.indoor).toBe(false);
    w.executeTool("take_action", act({ intent: "막사로 들어간다", place_to: "barracks" }));
    expect(feelsLike(content, w.state(), "guard_duty")?.indoor).toBe(true);
  });

  it("없는 장소는 거절하고 목록을 알린다. 즉흥 장소를 만들어 옮길 수 있다", () => {
    const w = world("role_a_grunt");
    const bad = w.executeTool("take_action", act({ place_to: "toilet" }));
    expect(bad.ok ? "" : bad.error).toContain("spawn_place");
    const made = w.executeTool("spawn_place", { name: "화장실", indoor: true, owner: null });
    expect(made.ok).toBe(true);
    const id = placesIn(w.state(), content, "a_base").find((p) => p.name === "화장실")!.id;
    expect(w.executeTool("take_action", act({ place_to: id })).ok).toBe(true);
    expect(currentPlace(w.state(), content)?.spawned).toBe(true);
  });

  it("바닥의 물건은 장소마다 남는다", () => {
    const w = world("role_a_grunt");
    w.executeTool("take_action", act({ place_to: "barracks" }));
    const me = w.state().playerId;
    const item = Object.keys(w.state().characters[me]!.inventory)[0]!;
    w.executeTool("transfer_item", { from: me, to: "scene", item_id: item, quantity: 1 });
    expect(w.state().scene.items[item]).toBe(1);
    w.executeTool("take_action", act({ place_to: "mess" }));
    expect(w.state().scene.items[item]).toBeUndefined();
    w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(w.state().scene.items[item]).toBe(1);
  });

  it("인물의 일과가 장소 이름·aliases와 맞으면 그 장소에 있다", () => {
    const w = world("role_a_grunt");
    const npc = Object.values(content.npcs).find((n) => n.zone === "a_base" && Object.values(n.routine ?? {}).some((r) => r.includes("의무실")))!;
    const seg = Object.entries(npc.routine).find(([, r]) => r!.includes("의무실"))![0];
    const start = { dawn: 5, morning: 8, day: 12, evening: 18, night: 22 }[seg as "dawn"]!;
    const day = Math.floor(w.state().time / 1440);
    expect(npcPlaceAt(w.state(), content, npc.id, day * 1440 + start * 60 + 30)).toBe("infirmary");
  });

  it("실내·바깥 이야기는 장소를 정했을 때만 거른다", () => {
    const w = world("role_a_grunt");
    expect(storyPlaceFits(w.state(), content, false)).toBe(true);
    w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(storyPlaceFits(w.state(), content, false)).toBe(false);
    expect(storyPlaceFits(w.state(), content, true)).toBe(true);
  });

  it("지붕 아래와 잠자리 (12-245): 거점의 바깥 장소는 지켜 주지만 바깥, 바깥 구역의 실내 장소는 지붕은 있지만 야영", () => {
    const w = world("role_a_grunt");
    w.executeTool("take_action", act({ place_to: "yard_gate" }));
    expect(shelterAt(content, w.state(), "sleep").indoor).toBe(false);
    expect(guardedHere(content, w.state())).toBe(true);
    expect(campSite(content, w.state())).toBeNull();
    w.ctx().store.append({ type: "zone_moved", from: "a_base", to: "old_town" });
    w.executeTool("take_action", act({ place_to: "shops", ignore_story: true }));
    expect(shelterAt(content, w.state(), "sleep").indoor).toBe(true);
    expect(guardedHere(content, w.state())).toBe(false);
    expect(campSite(content, w.state())).not.toBeNull();
  });

  it("인물은 어디에 (12-245): 갇힌 사람은 갇힌 곳, 다른 장소에 있을 사람은 가까이 있지 않다", () => {
    const w = world("role_a_grunt");
    const npc = Object.values(content.npcs).find((n) => n.zone === "a_base" && Object.values(n.routine ?? {}).some((r) => r.includes("의무실")))!;
    w.state().characters[npc.id]!.captive = { by: "faction_c", zone: "c_base" };
    expect(whereIs(w.state(), content, npc.id)?.zone).toBe("c_base");
    w.state().characters[npc.id]!.captive = null;
    w.executeTool("take_action", act({ place_to: "barracks" }));
    const at = whereIs(w.state(), content, npc.id);
    if (at?.place && at.place !== "barracks") expect(nearby(w.state(), content, npc.id)).toBe(false);
  });
});

describe("장소·동행·물건·붙잡힘 (PT14)", () => {
  it("동무조 T1: 들인 사람을 target으로 둔 place_to는 그 사람과 함께 옮긴다 (다음 호출이 오류가 되지 않는다)", () => {
    const w = world("role_c_comrades");
    expect(w.executeTool("npc_presence", { npc_id: "c_cm_jaeho", action: "enter" }).ok).toBe(true);
    const out = w.executeTool("take_action", act({ place_to: "yard", target: "c_cm_jaeho" }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(w.state().scene.present).toContain("c_cm_jaeho");
    const again = w.executeTool("take_action", act({ target: "c_cm_jaeho" }));
    expect(again.ok, again.ok ? "" : again.error).toBe(true);
  });

  it("거절되는 행동의 place_to는 옮기지도 시간을 쓰지도 않는다", () => {
    const w = world("role_c_comrades");
    const t = w.state().time;
    const out = w.executeTool("take_action", act({ place_to: "yard", use_item: "no_such_item" }));
    expect(out.ok).toBe(false);
    expect(currentPlace(w.state(), content)?.road).toBe(true);
    expect(w.state().time).toBe(t);
    // 옮겨 가는 곳에 있는 사람은 with로 부를 수 있다 (12-268). 다른 구역 사람은 거절
    const stray = w.executeTool("take_action", act({ place_to: "yard", with: ["a_taeho"] }));
    expect(stray.ok ? "" : stray.error).toContain("장면에 없다");
    expect(currentPlace(w.state(), content)?.road).toBe(true);
  });

  it("짐꾼 T1: 옮겨 가는 장소가 제자리인 사람과 with로 데려간 사람은 남고, 나머지는 원래 자리에 남는다", () => {
    const w = world("role_c_comrades");
    const s = w.state();
    // 창고 마당이 지금 제자리인 사람과 아닌 사람
    const ids = Object.values(content.npcs).filter((n) => n.zone === "c_warehouse" && !s.characters[n.id]?.dead).map((n) => n.id);
    const home = ids.find((id) => npcPlaceAt(s, content, id) === "yard");
    const others = ids.filter((id) => npcPlaceAt(s, content, id) !== "yard").slice(0, 2);
    expect(home && others.length === 2).toBeTruthy();
    for (const id of [home!, ...others]) expect(w.executeTool("npc_presence", { npc_id: id, action: "enter" }).ok).toBe(true);
    const out = w.executeTool("take_action", act({ place_to: "yard", with: [others[0]] }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(w.state().scene.present).toEqual(expect.arrayContaining([home!, others[0]!]));
    expect(w.state().scene.present).not.toContain(others[1]);
    expect(out.ok && out.resultText).toContain("원래 자리에 남았다");
  });

  it("떠돌이 T52: 같은 구역의 한 장소에 기다리게 한 동행은 그 장소를 떠났다 돌아오면 합류하고, npc_presence로 들여도 합류한다", () => {
    const w = world("role_l_wanderer");
    const dog = w.state().companions[0];
    expect(dog).toBeTruthy();
    const zone = w.state().playerZone!;
    const [p1, p2] = placesIn(w.state(), content, zone);
    expect(p1 && p2).toBeTruthy();
    w.executeTool("take_action", act({ place_to: p1!.id, ignore_story: true }));
    expect(w.executeTool("companion_part", { target: dog, how: "wait", hours: null }).ok).toBe(true);
    expect(w.state().companions).not.toContain(dog);
    w.executeTool("take_action", act({ place_to: p2!.id, ignore_story: true }));
    expect(w.state().companions).not.toContain(dog);
    w.executeTool("take_action", act({ place_to: p1!.id, ignore_story: true }));
    expect(w.state().companions).toContain(dog);
    expect(w.state().bonds[dog!]?.apart).toBeUndefined();
    // 다시 남겨 두고, 다른 장소에서 들이면 기다림이 풀린다
    w.executeTool("companion_part", { target: dog, how: "wait", hours: null });
    w.executeTool("take_action", act({ place_to: p2!.id, ignore_story: true }));
    expect(w.executeTool("npc_presence", { npc_id: dog, action: "enter" }).ok).toBe(true);
    expect(w.state().companions).toContain(dog);
    expect(w.state().bonds[dog!]?.apart).toBeUndefined();
  });

  it("방문자: 길에 내려놓은 물건은 그 길에 남고, place_to로 돌아가 찾는다", () => {
    const w = world("role_a_grunt");
    const me = w.state().playerId;
    const road = w.state().playerPlace!;
    const item = Object.keys(w.state().characters[me]!.inventory)[0]!;
    w.executeTool("transfer_item", { from: me, to: "scene", item_id: item, quantity: 1 });
    const moved = w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(moved.ok && moved.resultText).toContain(road);
    expect(w.state().scene.items[item]).toBeUndefined();
    const back = w.executeTool("take_action", act({ place_to: road }));
    expect(back.ok, back.ok ? "" : back.error).toBe(true);
    expect(currentPlace(w.state(), content)?.id).toBe(road);
    expect(w.state().scene.items[item]).toBe(1);
  });

  it("방문자·경비: 붙잡히면 그 무리의 가두는 장소에 갇히고, 붙잡힌 자리의 바닥 물건은 따라오지 않고, 빼앗긴 것과 동행의 행방을 적는다", () => {
    const w = world("role_t_visitor");
    const me = w.state().playerId;
    // 수용소가 있는 물류창고에서 붙잡히면 그 자리의 수용소에
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "c_warehouse" });
    w.executeTool("take_action", act({ place_to: "yard", ignore_story: true }));
    const item = Object.keys(w.state().characters[me]!.inventory)[0]!;
    w.executeTool("transfer_item", { from: me, to: "scene", item_id: item, quantity: 1 });
    const line = capturePlayer(w.ctx(), "faction_c");
    expect(line).toBeTruthy();
    expect(w.state().playerZone).toBe("c_warehouse");
    expect(currentPlace(w.state(), content)?.id).toBe("stockade");
    expect(w.state().scene.items[item]).toBeUndefined();
    expect(line).toContain("수용소");
    expect(line).not.toContain("무기와 탄은 빼앗겼다");
  });

  it("붙잡힌 곳에 가두는 장소가 없으면 그 무리 거점의 감방에", () => {
    const w = world("role_t_visitor");
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "old_town" });
    expect(jailFor(w.state(), content, "faction_c", "old_town")).toEqual({ zone: "c_base", place: "cells" });
    w.ctx().store.append({ type: "item_granted", to: w.state().playerId, itemId: "binoculars", quantity: 1 });
    const before = w.state().time;
    const line = capturePlayer(w.ctx(), "faction_c");
    // 다른 구역으로 끌려가면 그 길의 시간이 흐른다 (사용자 결정)
    expect(w.state().time - before).toBe(routeMinutes("old_town", "c_base"));
    expect(line).toContain("동안 끌려가");
    expect(line).toContain(`빼앗긴 것: `);
    expect(line).toContain(content.items.binoculars!.name);
    expect(line).toContain("철망 감방");
    expect(w.state().playerZone).toBe("c_base");
    expect(currentPlace(w.state(), content)?.id).toBe("cells");
    // 갇힌 사람은 갇힌 구역의 가두는 장소에 있다
    const npc = Object.values(content.npcs).find((n) => n.zone === "a_base")!;
    w.state().characters[npc.id]!.captive = { by: "faction_c", zone: "c_warehouse" };
    expect(whereIs(w.state(), content, npc.id)).toEqual({ zone: "c_warehouse", place: "stockade" });
  });
});

describe("머무는 자리 (12-253, 공통 규칙 15)", () => {
  it("두고 온 사람은 그 시간대가 끝날 때까지 그 자리에 있고, 그 뒤엔 일과로 돌아간다", () => {
    const w = world("role_c_comrades");
    w.executeTool("take_action", act({ place_to: "yard" }));
    const s = w.state();
    const id = Object.values(content.npcs).find((n) => n.zone === "c_warehouse" && !s.characters[n.id]?.dead && npcPlaceAt(s, content, n.id) && npcPlaceAt(s, content, n.id) !== "yard")!.id;
    const routine = npcPlaceAt(s, content, id);
    expect(w.executeTool("npc_presence", { npc_id: id, action: "enter" }).ok).toBe(true);
    const other = placesIn(s, content, "c_warehouse").find((p) => p.id !== "yard" && p.id !== routine)!.id;
    expect(w.executeTool("take_action", act({ place_to: other })).ok).toBe(true);
    expect(w.state().scene.present).not.toContain(id);
    expect(whereIs(w.state(), content, id)).toEqual({ zone: "c_warehouse", place: "yard" });
    const later = segmentEnd(w.state().time) + 1;
    expect(whereIs(w.state(), content, id, later)?.place).toBe(npcPlaceAt(w.state(), content, id, later));
  });

  it("같은 장소에 있는 사람을 target으로 부르면 장면에 들이고 행동한다", () => {
    const w = world("role_c_comrades");
    w.executeTool("take_action", act({ place_to: "yard" }));
    const s = w.state();
    const id = Object.values(content.npcs).find((n) => n.zone === "c_warehouse" && !s.characters[n.id]?.dead && !s.scene.present.includes(n.id) && whereIs(s, content, n.id)?.place === "yard")!.id;
    expect(hereWithMe(s, content, id)).toBe(true);
    const out = w.executeTool("take_action", act({ intent: "말을 건다", target: id }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok && out.resultText).toContain("장면에 들였다");
    expect(w.state().scene.present).toContain(id);
  });

  it("다른 장소에 있는 사람은 지금처럼 장면에 없다고 거절한다", () => {
    const w = world("role_c_comrades");
    w.executeTool("take_action", act({ place_to: "yard" }));
    const s = w.state();
    const id = Object.values(content.npcs).find((n) => n.zone === "c_warehouse" && !s.characters[n.id]?.dead && !s.scene.present.includes(n.id) && whereIs(s, content, n.id)?.place && whereIs(s, content, n.id)?.place !== "yard")!.id;
    const out = w.executeTool("take_action", act({ intent: "말을 건다", target: id }));
    expect(out.ok ? "" : out.error).toContain("장면에 없다");
  });

  it("일과 칸이 빈 시간대는 앞 시간대의 자리에 있다 (임동욱: 아침 칸이 비고 새벽은 창고 앞 보초)", () => {
    const w = world("role_a_grunt");
    const day = Math.floor(w.state().time / 1440);
    const dawn = npcPlaceAt(w.state(), content, "a_dongwook", day * 1440 + 5 * 60);
    expect(dawn).not.toBeNull();
    expect(npcPlaceAt(w.state(), content, "a_dongwook", day * 1440 + 8 * 60)).toBe(dawn);
  });

  it("GM 상태의 복무 줄에 상관이 지금 어디 있는지 적는다", () => {
    const w = world("role_a_grunt");
    const boss = commanderOf(w.state(), content)!;
    expect(describeMissionsForGm(w.state(), { content })).toMatch(new RegExp(`상관 .*\\(${boss}\\): 지금 `));
  });
});
