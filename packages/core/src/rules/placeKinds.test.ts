import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlaceKinds } from "../content/loader.ts";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { kindsOf, placesIn, storyPlaces, storyPlacesFit, storySummonsTo } from "./place.ts";

/** 공통 규칙 15 장소 종류 (12-300, docs/map-expansion-plan.md 1단계) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-kinds-")), content, rngFactory: () => createSeededRng(5) }).create("mcp", roleId, choice);

describe("장소 종류 (12-300)", () => {
  it("모든 장소에 종류가 있고, 길·가두는 곳은 표시로 저절로 붙는다", () => {
    for (const l of Object.values(content.locations)) for (const p of l.places) expect(kindsOf(p).length, `${l.id}.${p.id}`).toBeGreaterThan(0);
    const road = content.locations.a_base!.places.find((p) => p.road)!;
    expect(kindsOf(road)).toContain("road");
    expect(kindsOf(content.locations.a_base!.places.find((p) => p.jail)!)).toContain("jail");
    expect(checkPlaceKinds(content)).toEqual([]);
  });

  it("고르는 순서: 장소 id → 종류 → 글자 맞추기", () => {
    const s = { ...world("role_a_grunt").state(), playerZone: "a_base", playerPlace: null };
    expect(storyPlaces(s, content, { places: ["barracks"], place_kinds: ["mess"] }, "")).toEqual(["barracks"]);
    expect(storyPlaces(s, content, { place_kinds: ["mess"] }, "막사에서")).toEqual(["mess"]);
    expect(storyPlaces(s, content, undefined, "막사에서")).toEqual(["barracks"]);
  });

  it("종류의 장소가 그 구역에 없으면 열리지 않고, 있으면 그 장소들에서만", () => {
    const s = world("role_a_grunt").state();
    const atMess = { ...s, playerZone: "a_base", playerPlace: "mess" };
    expect(storyPlacesFit(atMess, content, { place_kinds: ["mess"] }, "")).toBe(true);
    expect(storyPlacesFit({ ...atMess, playerPlace: "barracks" }, content, { place_kinds: ["mess"] }, "")).toBe(false);
    // 고가도로에는 먹는 곳이 없다
    const overpass = placesIn(s, content, "overpass")[0]!;
    expect(storyPlacesFit({ ...s, playerZone: "overpass", playerPlace: overpass.id }, content, { place_kinds: ["mess"] }, "")).toBe(false);
  });

  it("부르는 이야기는 그 종류의 장소가 여럿이면 가장 가까운 곳으로", () => {
    const s = world("role_a_grunt").state();
    const zone = Object.values(content.locations).find((l) => l.places.filter((p) => kindsOf(p).includes("gate")).length > 1)!;
    const gates = zone.places.filter((p) => kindsOf(p).includes("gate")).map((p) => p.id);
    const from = gates[0]!;
    const near = { ...s, playerZone: zone.id, playerPlace: zone.places.find((p) => p.near.includes(from) && !gates.includes(p.id))?.id ?? from };
    const to = storySummonsTo(near, content, { place_kinds: ["gate"] }, "", true);
    if (near.playerPlace === from) expect(to).toBeNull();
    else expect(gates).toContain(to);
    expect(storySummonsTo({ ...near, playerPlace: from }, content, { place_kinds: ["gate"] }, "", true)).toBeNull(); // 이미 그 종류의 자리
  });

  it("검사: 모르는 종류, 종류 없는 장소, 구역에 없는 종류를 잡는다", () => {
    const bad = structuredClone(content) as Content;
    bad.locations.a_base!.places[0]!.kinds = ["nope"];
    const story = Object.values(bad.storylets).find((x) => x.when.zones?.includes("overpass") && !x.when.places)!;
    story.when.place_kinds = ["mess"];
    const problems = checkPlaceKinds(bad);
    expect(problems.some((p) => p.includes("알 수 없는 종류 nope"))).toBe(true);
    expect(problems.some((p) => p.includes("overpass에 그 종류(mess)의 장소가 없다"))).toBe(true);
  });
});
