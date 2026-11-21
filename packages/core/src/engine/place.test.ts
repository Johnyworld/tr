import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { createSeededRng } from "../rng.ts";
import { currentPlace, guardedHere, nearby, npcPlaceAt, placeIndoor, placesIn, shelterAt, storyPlaceFits, whereIs } from "../rules/place.ts";
import { campSite } from "./camp.ts";
import { feelsLike } from "./climate.ts";

const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-place-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", roleId, choice);
const act = (input: Record<string, unknown>) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

describe("구역 안의 장소 (12-244, 공통 규칙 15)", () => {
  it("같은 구역 안의 장소로 5분에 옮기고, 실내외는 그 장소를 따른다", () => {
    const w = world("role_a_grunt");
    expect(w.state().playerZone).toBe("a_base");
    expect(currentPlace(w.state(), content)).toBeNull();
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
