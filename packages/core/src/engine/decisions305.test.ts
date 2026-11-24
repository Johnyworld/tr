import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describePlayerState } from "./context.ts";
import { conditionsMet, storyletOf } from "../story/storylets.ts";
import { activeMissionOf, atMissionPlace } from "../game/missions.ts";
import type { StoryletEffect } from "../content/schemas.ts";
import { releaseBuddies } from "./companionTools.ts";
import { applyEffect, runRoadEvent } from "./storyletTools.ts";
import { doorNumber, knowsWhoIsAt, resolvePlace, unknownDoors } from "../rules/place.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { placeListLines } from "../views/map.ts";
import { WorldManager } from "../world/manager.ts";

/** PT29 뒤 고침 (12-305) */
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
const check = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const content = loadRealContent();
const world = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-305-")), content, rngFactory: () => createSeededRng(7) }).create("mcp", role);

describe("남의 땅 장소의 있을 사람 (12-305)", () => {
  it("처음 닿은 적 거점에서는 지금 자리 말고 다른 장소의 있을 사람이 보이지 않는다", () => {
    const w = world();
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "c_base" });
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "to_old_town" });
    // 붉은연합 사람을 모두 얼굴로 안다 (PT29 졸병: 원수인 약탈조장)
    for (const npc of Object.values(content.npcs)) if (npc.zone === "c_base") w.ctx().store.append({ type: "face_known", characterId: w.state().playerId, targetId: npc.id });
    const s = w.state();
    expect(knowsWhoIsAt(s, content, "c_base", "to_old_town")).toBe(true);
    expect(knowsWhoIsAt(s, content, "c_base", "checkpoint_1")).toBe(false);
    const text = describePlayerState(w.state(), content);
    expect(text).toContain("to_old_town");
    const lines = text.split("\n").filter((l) => l.includes("있을 사람:"));
    for (const l of lines) expect(l, l).toContain("지금 여기");
  });

  it("우리 땅에서는 모든 장소의 있을 사람이 보인다", () => {
    const w = world();
    const s = w.state();
    const zone = s.playerZone!;
    for (const p of content.locations[zone]!.places) expect(knowsWhoIsAt(s, content, zone, p.id)).toBe(true);
  });
});

describe("이야기 중 판정을 건 긴 활동 (12-305)", () => {
  it("이야기가 열려 있으면 그 선택지의 스킬이 아닌 판정을 건 수색은 거절된다", () => {
    const w = world();
    const zone = Object.values(content.locations).find((l) => l.loot && l.loot.modifier !== 0 && !l.owner)!;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: zone.id });
    const search = content.scenario.exploration!.search_move;
    const stat = (id: string) => content.scenario.moves.find((m) => m.id === id)!.stats[0]!;
    for (let i = 0; i < 12 && !w.state().activeStorylet; i++) w.executeTool("take_action", act({ ignore_story: true, activity: { kind: "search", until: null }, check: check(search, stat(search)) }));
    const open = w.state().activeStorylet;
    expect(open, "이야기가 열리지 않았다").toBeTruthy();
    const story = storyletOf(w.state(), content, open!.id)!;
    const other = content.scenario.moves.find((m) => !story.choices.some((c) => c.check === m.id) && m.kind !== "expert")!;
    const t0 = w.state().time;
    const r = w.executeTool("take_action", act({ activity: { kind: "search", until: null }, check: check(other.id, stat(other.id)) }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("열려 있다");
    expect(w.state().time).toBe(t0);
  });
});

describe("문 번호 고정 (12-305)", () => {
  it("문 하나를 알게 되어도 남은 문의 번호는 그대로다", () => {
    const w = world();
    const s0 = w.state();
    // 담 안 장소로 이어지는 이웃이 둘 이상인 남의 땅 자리 (길·담 문·담 밖은 보여서 아는 곳이라 문이 아니다)
    const inner = (loc: (typeof content.locations)[string], id: string) => { const q = loc.places.find((x) => x.id === id); return !!q && !q.road && !q.gate; };
    let found: { zone: string; at: string } | null = null;
    for (const [zone, loc] of Object.entries(content.locations)) {
      if (loc.owner === s0.characters[s0.playerId]!.factionId) continue;
      for (const p of loc.places) if (!found && p.near.filter((id) => inner(loc, id)).length >= 3) found = { zone, at: p.id };
    }
    expect(found).toBeTruthy();
    w.ctx().store.append({ type: "zone_moved", from: s0.playerZone, to: found!.zone });
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: found!.at });
    const doors = unknownDoors(w.state(), content);
    expect(doors.length).toBeGreaterThanOrEqual(2);
    const [first, second] = [doors[0]!, doors[1]!];
    const before = doorNumber(w.state(), content, second.id);
    // 첫 문을 지나갔다 돌아온다
    w.ctx().store.append({ type: "place_moved", from: found!.at, to: first.id });
    w.ctx().store.append({ type: "place_moved", from: first.id, to: found!.at });
    expect(unknownDoors(w.state(), content).map((p) => p.id)).not.toContain(first.id);
    expect(doorNumber(w.state(), content, second.id)).toBe(before);
    expect(resolvePlace(w.state(), content, `문${before}`)?.id).toBe(second.id);
    expect(resolvePlace(w.state(), content, `문${doorNumber(w.state(), content, first.id)}`)).toBeUndefined();
  });
});

describe("?지도 깊이 이름 (12-305)", () => {
  it("?지도 목록의 깊이 이름은 GM 장소 줄과 같다", () => {
    const w = world();
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: "c_base" });
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "to_old_town" });
    const names = content.scenario.infiltration!.depths;
    const list = placeListLines(w.state(), content).join("\n");
    const gm = describePlayerState(w.state(), content);
    const tag = (text: string) => /붉은 다리 가는 길 \[([^\]]+)\]/.exec(text)?.[1];
    expect(tag(list)).toBe(names[0]);
    expect(tag(gm)).toBe(tag(list));
  });
});

describe("탈영병 임무 (12-305)", () => {
  const withMission = () => {
    const w = world("role_c_raider");
    const commander = content.roles.role_c_raider!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["c_deserter_hunt"] });
    const r = w.executeTool("assign_mission", { template_id: "c_deserter_hunt" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const s = w.state();
    const mission = activeMissionOf(s.missions, s.playerId)!;
    const place = Object.keys(content.locations).find((z) => atMissionPlace(mission, z, s.zones, s.factions))!;
    w.ctx().store.append({ type: "zone_moved", from: s.playerZone, to: place });
    const road = content.locations[place]!.places.find((p) => p.road)!;
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: road.id });
    return { w, mission };
  };

  it("놓친 탈영병 이야기는 같은 임무에서 다른 얼굴로 다시 열리지 않는다", () => {
    const { w } = withMission();
    const story = content.storylets.ms_deserter_found!;
    expect(conditionsMet(w.state(), content, story, w.state().time)).toBe(true);
    const runner = Object.values(w.state().characters).find((c) => c.factionId === "red_union" && c.id !== w.state().playerId && !c.dead)?.id ?? Object.keys(w.state().characters).find((id) => id !== w.state().playerId)!;
    w.ctx().store.append({ type: "storylet_fired", storyletId: story.id, cast: { runner }, expiresAt: w.state().time + 60 });
    const r = w.executeTool("resolve_storylet", { choice_id: "let_go" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(conditionsMet(w.state(), content, story, w.state().time + 30)).toBe(false);
  });

  it("임무 이야기로 데려온 사람은 보고하면 무리에 넘긴다", () => {
    const { w, mission } = withMission();
    const story = content.storylets.ms_deserter_found!;
    const runner = Object.keys(w.state().characters).find((id) => id !== w.state().playerId && !w.state().companions.includes(id) && !w.state().characters[id]!.dead && !w.state().characters[id]!.away)!;
    // 효과는 이야기를 끝낸 뒤 적용된다 (열린 이야기 없음)
    applyEffect(w.ctx(), { companion_join: { who: "runner", kind: "purpose", until: { hours: 12 } } } as StoryletEffect, { runner }, {}, story.title, { source: story.id });
    expect(w.state().bonds[runner]?.missionId).toBe(mission.id);
    const lines = releaseBuddies(w.ctx(), mission.id);
    expect(lines.join("\n")).toContain("무리에 넘겼다");
    expect(w.state().companions).not.toContain(runner);
  });
});

describe("길목 공통 이야기 (12-305)", () => {
  it("길목에 들어설 때의 길 위의 일은 길목 이야기를 먼저 고른다", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) {
      const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-305-")), content, rngFactory: () => createSeededRng(seed) }).create("mcp", "role_a_grunt");
      const from = w.state().playerZone!;
      w.ctx().store.append({ type: "zone_moved", from, to: "red_bridge" });
      const road = content.locations.red_bridge!.places.find((p) => p.road)!;
      w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: road.id });
      if (w.state().activeStorylet) w.ctx().store.append({ type: "storylet_expired", storyletId: w.state().activeStorylet!.id });
      runRoadEvent(w.ctx(), 100);
      const open = w.state().activeStorylet;
      if (open) seen.add(open.id);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) expect(content.storylets[id]?.when.zone_kinds, id).toContain("corridor");
  });
});
