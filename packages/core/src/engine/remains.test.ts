import { arrivalPlace, zoneOf } from "../rules/place.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { describePlayerState } from "./context.ts";
import { leaveRemainsForNewDeaths, livingIds, lootRemainsDaily } from "./remains.ts";
import { executeTool } from "./tools.ts";
import { conditionsMet } from "../story/storylets.ts";

/** 유해와 무덤 (12-130) */
const content = loadRealContent();

const act = (input: Record<string, unknown>) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

function open(rng = 0.99) {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-remains-")), content, rngFactory: () => () => rng }).create("mcp", "role_a_grunt");
  const s = () => w.state();
  /** a_taeho를 죽이고 그 자리로 간다 */
  const killTaeho = (track = content.scenario.harm_track) => {
    const before = livingIds(s());
    const levels = content.scenario.condition_tracks.find((t) => t.id === track)!.levels;
    changeCondition(w.ctx(), "a_taeho", track, levels.length, "cheat", "테스트");
    leaveRemainsForNewDeaths(w.ctx(), before);
  };
  return { w, s, killTaeho };
}

describe("유해", () => {
  it("이름 있는 인물이 다쳐 죽으면 그 구역에 유해가 남고, 짐은 그 사람이 그대로 지닌다", () => {
    const { s, killTaeho } = open();
    s().characters.a_taeho!.inventory = { cigarettes: 2 };
    killTaeho();
    expect(s().remains).toHaveLength(1);
    expect(s().remains[0]).toMatchObject({ of: "a_taeho", holder: "a_taeho", buriedAt: null });
    expect(s().characters.a_taeho!.inventory.cigarettes).toBe(2);
  });

  it("함께 걷다 죽은 동행은 곁에서 빠져도 평소 자리(집)가 아니라 주인공이 있는 곳에 유해가 남는다 (PT36)", () => {
    const { w, s } = open();
    const home = zoneOf(s(), content, "a_taeho");
    w.ctx().store.append({ type: "companion_joined", characterId: "a_taeho" });
    const away = Object.keys(content.locations).find((z) => z !== s().playerZone && z !== home && content.locations[z]!.kind !== "base")!;
    s().playerZone = away;
    const before = livingIds(s());
    w.ctx().store.append({ type: "companion_left", characterId: "a_taeho" });
    const levels = content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)!.levels;
    changeCondition(w.ctx(), "a_taeho", content.scenario.harm_track, levels.length, "cheat", "테스트");
    leaveRemainsForNewDeaths(w.ctx(), before);
    expect(s().remains[0]).toMatchObject({ of: "a_taeho", zone: away });
  });

  it("감염으로 죽으면 변이하므로 유해가 없고, 변이한 그 사람을 쓰러뜨리면 그때 유해가 남는다", () => {
    const { w, s, killTaeho } = open();
    killTaeho(content.scenario.body!.infection!.track);
    expect(s().remains).toHaveLength(0);
    const turned = Object.values(s().characters).find((c) => c.extra?.turnedFrom === "a_taeho")!;
    const before = livingIds(s());
    changeCondition(w.ctx(), turned.id, content.scenario.harm_track, 99, "cheat", "테스트");
    leaveRemainsForNewDeaths(w.ctx(), before);
    expect(s().remains[0]).toMatchObject({ of: "a_taeho", holder: turned.id });
  });

  it("이름 없는 엑스트라는 유해를 남기지 않는다", () => {
    const { w, s } = open();
    const spawned = executeTool("spawn_extra", { template: "stray_dog", label: "누렁이" }, w.ctx());
    expect(spawned.ok).toBe(true);
    const dog = Object.values(s().characters).find((c) => c.extra?.template === "stray_dog")!;
    const before = livingIds(s());
    changeCondition(w.ctx(), dog.id, content.scenario.harm_track, 99, "cheat", "테스트");
    leaveRemainsForNewDeaths(w.ctx(), before);
    expect(s().remains).toHaveLength(0);
  });

  it("그 구역에 가면 GM이 유해를 보고, 짐을 뒤져 가져올 수 있다", () => {
    const { w, s, killTaeho } = open();
    s().characters.a_taeho!.inventory = { cigarettes: 2 };
    killTaeho();
    const zone = s().remains[0]!.zone;
    s().playerZone = "elsewhere";
    expect(executeTool("transfer_item", { from: "a_taeho", to: s().playerId, item_id: "cigarettes", quantity: 1 }, w.ctx()).ok).toBe(false);
    s().playerZone = zone;
    expect(describePlayerState(s(), content)).toContain("묻히지 않은 유해");
    const before = s().characters[s().playerId]!.inventory.cigarettes ?? 0;
    expect(executeTool("transfer_item", { from: "a_taeho", to: s().playerId, item_id: "cigarettes", quantity: 1 }, w.ctx()).ok).toBe(true);
    expect(s().characters[s().playerId]!.inventory.cigarettes).toBe(before + 1);
  });

  it("묻으면 무덤이 되고, 같은 무리 사람이면 사기가 오른다. 묻은 뒤에는 짐에 손이 닿지 않는다", () => {
    const { w, s, killTaeho } = open();
    s().characters.a_taeho!.inventory = { cigarettes: 2 };
    killTaeho();
    s().playerZone = s().remains[0]!.zone;
    s().remains[0]!.spot = null; // 자리를 보지 않는 테스트 (유해 자리는 decisions287)
    // 바깥 이야기라 그 구역의 길에서 본다 (12-279 실내외)
    w.ctx().store.append({ type: "place_moved", from: s().playerPlace, to: arrivalPlace(s(), content, s().playerZone!) });
    const me = s().characters[s().playerId]!;
    s().factions[me.factionId]!.morale = 0;
    const out = executeTool("take_action", act({ bury: { who: "a_taeho", words: "끝까지 초소를 지켰다" } }), w.ctx());
    expect(out.ok).toBe(true);
    const r = s().remains[0]!;
    expect(r.buriedAt).not.toBeNull();
    expect(r.marker).toContain("끝까지 초소를 지켰다");
    expect(s().factions[me.factionId]!.morale).toBe(1);
    expect(describePlayerState(s(), content)).toContain("이 구역의 무덤");
    expect(executeTool("transfer_item", { from: "a_taeho", to: s().playerId, item_id: "cigarettes", quantity: 1 }, w.ctx()).ok).toBe(false);
  });

  it("묻지 않은 유해는 주인공이 없는 사이 누군가 털어 간다", () => {
    const { w, s, killTaeho } = open(0);
    s().characters.a_taeho!.inventory = { cigarettes: 2 };
    killTaeho();
    s().playerZone = "elsewhere";
    lootRemainsDaily(w.ctx());
    expect(s().characters.a_taeho!.inventory.cigarettes ?? 0).toBe(0);
  });

  it("계승 이야기는 이전 주인공의 유해·무덤이 있는 구역에서만 열린다", () => {
    const { w, s, killTaeho } = open();
    killTaeho();
    s().playerZone = s().remains[0]!.zone;
    s().remains[0]!.spot = null; // 자리를 보지 않는 테스트 (유해 자리는 decisions287)
    // 바깥 이야기라 그 구역의 길에서 본다 (12-279 실내외)
    w.ctx().store.append({ type: "place_moved", from: s().playerPlace, to: arrivalPlace(s(), content, s().playerZone!) });
    const pack = content.storylets.lg_familiar_pack!;
    const flowers = content.storylets.lg_flowers!;
    const at = s().time - (s().time % 1440) + 10 * 60; // 오전
    expect(conditionsMet(s(), content, pack, at)).toBe(false); // 이전 주인공이 아니다
    s().chronicle.push({ characterId: "a_taeho", name: "강태호", factionId: "faction_a", rank: "grunt", startedAt: 0, diedAt: s().time, merit: 0, cause: "테스트", deeds: [], epitaph: null });
    expect(conditionsMet(s(), content, pack, at)).toBe(true);
    expect(conditionsMet(s(), content, flowers, at)).toBe(false);
    expect(executeTool("take_action", act({ bury: { who: "a_taeho", words: null } }), w.ctx()).ok).toBe(true);
    expect(conditionsMet(s(), content, pack, at)).toBe(false);
    expect(conditionsMet(s(), content, flowers, at)).toBe(true);
  });
});
