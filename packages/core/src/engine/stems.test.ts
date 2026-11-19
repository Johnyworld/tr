import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { conditionsMet, castCandidates } from "../story/storylets.ts";
import { hasInterest, romanceCast } from "./romance.ts";
import type { GameState } from "../game/state.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { runCommand } from "../commands/commands.ts";

/** 줄기 (12-193): 다짐 근처 조건, 연애 배역, 몸살 기운 */
const real = loadRealContent();
const content = { ...real, storylets: {} };
const make = (role: string) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-stems-")), content, rngFactory: () => () => 0.99 }).create("mcp", role);

describe("다짐 대상 근처 (near_target)", () => {
  it("대상 구역이나 맞닿은 구역에서만 열린다", () => {
    const w = make("role_l_wanderer");
    const target = real.roles.role_l_wanderer!.resolve!.target!;
    w.executeTool("take_action", { intent: "둘러본다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
    w.ctx().store.append({ type: "resolve_stepped", characterId: w.state().playerId, text: "a" });
    w.ctx().store.append({ type: "resolve_stepped", characterId: w.state().playerId, text: "b" });
    const story = real.storylets.rs2_home_threshold!;
    const far = Object.values(real.locations).find((l) => l.id !== target && !(l.adjacent ?? []).includes(target) && !(real.locations[target]!.adjacent ?? []).includes(l.id))!.id;
    const at = (zone: string) => ({ ...w.state(), playerZone: zone });
    const morning = (s: ReturnType<typeof at>) => conditionsMet(s, real, story, s.time);
    expect(morning(at(target))).toBe(true);
    expect(morning(at(Object.values(real.locations).find((l) => (l.adjacent ?? []).includes(target))!.id))).toBe(true); // 맞닿음은 한쪽에만 적혀 있을 수 있다
    expect(morning(at(far))).toBe(false);
  });
});

describe("연애 배역 (12-193)", () => {
  it("마음이 있는 사람은 주인공이 만난 사람만", () => {
    const w = make("role_a_grunt");
    const s = w.state();
    const other = Object.keys(s.characters).find((id) => id !== s.playerId && !s.met[s.playerId]?.includes(id) && !(s.known[s.playerId] ?? []).includes(id) && s.characters[id]!.gender)!;
    const relations: GameState["relations"] = { ...s.relations, [other]: { ...s.relations[other], [s.playerId]: { ...NEUTRAL_RELATION, affection: 9 } } };
    const stranger: GameState = { ...s, relations };
    expect(romanceCast(stranger, real, "suitor")).not.toContain(other);
    const met: GameState = { ...stranger, met: { ...stranger.met, [s.playerId]: [...(stranger.met[s.playerId] ?? []), other] } };
    // 만났으면 마음(끌림·호감)대로 후보가 된다
    expect(romanceCast(met, real, "suitor").includes(other)).toBe(hasInterest(met, real, other, s.playerId));
  });

  it("연애 배역에도 무리 조건이 먹는다", () => {
    const w = make("role_a_grunt");
    expect(castCandidates(w.state(), real, { faction: "own" } as never).every((id) => w.state().characters[id]!.factionId === "faction_a")).toBe(true);
  });
});

describe("몸살 기운 (12-193)", () => {
  it("질병 첫 증상은 '몸살 기운'이고 ?상태에 낫는 길이 보인다", () => {
    const w = make("role_a_grunt");
    expect(w.runCheat("~set disease chill").ok).toBe(true);
    const text = runCommand("?상태", { state: w.state(), content: real, summaries: [] });
    expect(text).toContain("몸살 기운");
    expect(text).toContain("해열제");
  });
});
