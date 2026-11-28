import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { createTakeActionSchema, takeAction } from "../engine/action.ts";
import { placesIn } from "./place.ts";
import { scavengeParts } from "../engine/scavenge.ts";
import { shopHere, shopsLeft } from "./shop.ts";

/** 공통 규칙 28: 가게 (12-367). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const schema = createTakeActionSchema(content.scenario);

function world() {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-shop-")), content, rngFactory: () => createSeededRng(3) });
  const w = m.create("mcp", "role_t_visitor", choice);
  w.runCheat("~goto old_town");
  w.runCheat("~time morning");
  w.state().scene.present = [];
  w.state().playerPlace = "alleys";
  return w;
}
const search = (target: string | null, place_to: string | null = null) =>
  schema.parse({
    intent: "찾는다", check: { move: "scavenge", stat: "senses", difficulty: "normal", harm_on_failure: "none" },
    activity: { kind: "search", until: null, hours: null, scope: "room", target }, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, place_to,
  });
const win = (w: ReturnType<typeof world>) => ({ ...w.ctx(), rng: () => 0.99 }); // 주사위 6+6: 성공
const lose = (w: ReturnType<typeof world>) => ({ ...w.ctx(), rng: () => 0 });

describe("가게 찾기 (공통 규칙 28)", () => {
  it("성공하면 가게 장소가 하나 생기고, 길이 가진 수까지만 찾는다", () => {
    const w = world();
    expect(shopsLeft(w.state(), content)).toEqual({ pharmacy: 1, convenience: 1, electronics: 1 });
    const first = takeAction(search("pharmacy"), win(w));
    expect(first.ok && first.resultText).toContain("약국을 찾았다");
    const shop = placesIn(w.state(), content, "old_town").find((p) => p.shop === "pharmacy")!;
    expect(shop).toBeTruthy();
    expect(shop.indoor).toBe(true);
    expect(shop.near).toContain("alleys");
    expect(shopsLeft(w.state(), content)).toEqual({ convenience: 1, electronics: 1 });
    // 이 길의 약국은 다 찾았다: 시간이 흐르기 전에 거절
    const t = w.state().time;
    const again = takeAction(search("pharmacy"), win(w));
    expect(again.ok).toBe(false);
    expect(w.state().time).toBe(t);
  });

  it("있을 만하지 않은 가게, 실내에서 찾는 것은 거절한다", () => {
    const w = world();
    const no = takeAction(search("hardware"), win(w));
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.error).toContain("있을 만하지 않다");
    w.state().playerPlace = "shops";
    const indoor = takeAction(search("pharmacy"), win(w));
    expect(indoor.ok).toBe(false);
  });

  it("실패하면 가게가 생기지 않고 다시 찾을 수 있다", () => {
    const w = world();
    const miss = takeAction(search("electronics"), lose(w));
    expect(miss.ok && miss.resultText).toContain("찾지 못했다");
    expect(placesIn(w.state(), content, "old_town").some((p) => p.shop)).toBe(false);
    expect(shopsLeft(w.state(), content).electronics).toBe(1);
  });

  it("가게 안을 뒤지면 그 가게 종류의 표에서만 나온다", () => {
    const w = world();
    takeAction(search("pharmacy"), win(w));
    const shop = placesIn(w.state(), content, "old_town").find((p) => p.shop === "pharmacy")!;
    w.state().playerPlace = shop.id;
    expect(shopHere(w.state(), content)?.kind).toBe("pharmacy");
    const table = new Set(content.scenario.shops!.kinds.pharmacy!.loot.items.map((i) => i.item));
    const before = { ...w.state().characters[w.state().playerId]!.inventory };
    const r = takeAction(search(null), win(w));
    expect(r.ok).toBe(true);
    const after = w.state().characters[w.state().playerId]!.inventory;
    const got = Object.keys(after).filter((k) => (after[k] ?? 0) > (before[k] ?? 0));
    expect(got.length).toBeGreaterThan(0);
    for (const k of got) expect(table.has(k)).toBe(true);
  });

  it("가게 찾기의 다시 뒤짐은 종류마다 따로 센다 (PT46)", () => {
    const w = world();
    for (let i = 0; i < 3; i++) takeAction(search("electronics"), lose(w));
    const penalty = (target: string | null) => Math.abs(scavengeParts(w.ctx(), target).find((p) => p.label === "오늘 다시 뒤짐")?.value ?? 0);
    expect(penalty("electronics")).toBeGreaterThanOrEqual(3);
    expect(penalty("pharmacy")).toBe(0);
    expect(penalty(null)).toBe(0);
  });

  it("GM이 가게를 spawn_place로 지어내면 찾는 수색으로 안내한다", () => {
    const w = world();
    const r = w.executeTool("spawn_place", { name: "작은 약국", indoor: true, owner: null });
    expect(JSON.stringify(r)).toContain("target");
    expect(placesIn(w.state(), content, "old_town").some((p) => p.name === "작은 약국")).toBe(false);
  });
});
