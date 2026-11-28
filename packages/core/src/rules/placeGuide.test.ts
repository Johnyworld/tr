import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { knowsPlace, npcKnownZones, npcKnowsPlace, npcPlaceGuide, placesIn } from "./place.ts";
import { isCreature } from "../game/kinds.ts";
import { neighbors } from "../sim/war.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 인물이 아는 곳과 길 일러 주기 (12-360, 튜토리얼: 구시가 상가 지하를 아는 길잡이가 바로 옆 약국을 "모른다"고 했다) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function inOldTown() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-guide-")), content, rngFactory: () => createSeededRng(5) });
  const w = m.create("mcp", "role_t_visitor", choice);
  w.runCheat("~goto old_town");
  return w;
}

describe("인물이 아는 곳 (12-360)", () => {
  it("'아는 것'에 구역 이름이 나오면 그 구역의 장소를 다 안다: 문하늘은 구시가의 약국도 안다", () => {
    const w = inOldTown();
    const s = w.state();
    expect(npcKnownZones(s, content, "a_haneul")).toContain("old_town");
    expect(npcKnownZones(s, content, "a_haneul")).toContain("a_base");
    expect(npcKnowsPlace(s, content, "a_haneul", "old_town", "shops")).toBe(true);
  });

  it("동물과 주인공은 셈하지 않는다", () => {
    const w = inOldTown();
    const s = w.state();
    expect(npcKnownZones(s, content, s.playerId)).toEqual([]);
    const animal = Object.values(s.characters).find((c) => isCreature(content, c));
    if (animal) expect(npcKnownZones(s, content, animal.id)).toEqual([]);
  });

  it("들어도 주인공은 그 장소를 모른다: 길 안내는 문 번호와 어림뿐이고, 주인공의 아는 장소는 그대로다", () => {
    const w = inOldTown();
    const s = w.state();
    const before = placesIn(s, content, "old_town").filter((p) => knowsPlace(s, content, "old_town", p.id)).map((p) => p.id);
    const g = npcPlaceGuide(s, content, "a_haneul")!;
    expect(g.knows).toBe(true);
    const named = [...g.doors.map((d) => d.place.id), ...g.far.map((f) => f.place.id)];
    expect(named).toContain("shops");
    // 이미 아는 곳은 다시 일러 주지 않는다
    for (const id of named) expect(before).not.toContain(id);
    for (const d of g.doors) expect(d.door).toBeGreaterThan(0);
    expect(w.state().knownPlaces?.[s.playerId] ?? []).toEqual(s.knownPlaces?.[s.playerId] ?? []);
  });

  it("장면의 길잡이 카드에 아는 곳이 실리고, 모르는 장소는 여전히 '알 수 없는 문'으로 고를 수 없다", () => {
    const w = inOldTown();
    w.runCheat("~summon 문하늘");
    expect(w.state().scene.present).toContain("a_haneul");
    const scene = w.sceneForGm();
    expect(scene).toContain("이 인물이 아는 구시가의 곳");
    expect(scene).toContain("상가·약국 안");
    expect(scene).not.toContain("구시가를 잘 모른다");
    expect(knowsPlace(w.state(), content, "old_town", "shops")).toBe(false);
  });

  it("구역을 모르는 인물은 카드에 '잘 모른다'가 붙는다", () => {
    const w = inOldTown();
    const s = w.state();
    const stranger = Object.keys(content.npcs).find((id) => s.characters[id] && !s.characters[id]!.dead && !npcKnownZones(s, content, id).includes("old_town"));
    expect(stranger).toBeDefined();
    w.runCheat(`~summon ${s.characters[stranger!]!.name}`);
    expect(w.sceneForGm()).toContain("구시가를 잘 모른다");
    expect(npcPlaceGuide(w.state(), content, stranger!)!.knows).toBe(false);
  });

  it("수색대원은 사는 구역에서 이웃 2칸까지 알고, 그 안의 남의 무리 거점은 모른다 (12-361)", () => {
    const w = inOldTown();
    const s = w.state();
    const scouts = Object.entries(content.npcs).filter(([id, n]) => n.occupation === "scavenger" && n.zone && s.characters[id]);
    expect(scouts.length).toBeGreaterThan(10);
    for (const [id, n] of scouts) {
      const zones = npcKnownZones(s, content, id);
      for (const z of neighbors(content, n.zone!)) if (content.locations[z]?.kind !== "base") expect(zones, `${id} ${z}`).toContain(z);
      for (const z of zones) {
        if (content.locations[z]?.kind !== "base" || z === n.zone) continue;
        const own = s.zones[z]?.owner === s.characters[id]!.factionId;
        const told = n.knows.some((f) => f.includes(content.locations[z]!.name));
        expect(own || told, `${id}: 남의 거점 ${z}`).toBe(true);
      }
    }
    // 청솔 거점 수색대원은 '아는 것'이 없어도 차고지 너머 구시가를 안다
    const aScout = scouts.find(([, n]) => n.zone === "a_base" && !n.knows.some((f) => f.includes("구시가")));
    expect(aScout).toBeDefined();
    expect(npcKnownZones(s, content, aScout![0])).toContain("old_town");
  });

  it("길을 아는 넓이가 없는 직분은 사는 구역·무리 땅·'아는 것'만 안다", () => {
    const w = inOldTown();
    const s = w.state();
    const cook = Object.entries(content.npcs).find(([id, n]) => n.occupation === "cook" && n.zone && s.characters[id] && !n.knows.some((f) => f.includes("구시가")) && s.zones.old_town?.owner !== s.characters[id]!.factionId);
    expect(cook).toBeDefined();
    expect(npcKnownZones(s, content, cook![0])).not.toContain("old_town");
  });
});
