import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { factionPeers, standingInFaction } from "../game/politics.ts";
import { conditionsMet, castCandidates } from "../story/storylets.ts";

/** 무리 안의 정치 (12-152) */
const content = loadRealContent();
const make = (role = "role_a_grunt") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-politics-")), content, rngFactory: () => () => 0.5 }).create("mcp", role);
type World = ReturnType<typeof make>;
const me = (w: World) => w.state().characters[w.state().playerId]!;
/** 같은 무리 사람 n명이 주인공을 믿지 않게 */
function distrustMe(w: World, n: number) {
  const peers = factionPeers(w.state(), content, me(w).id).slice(0, n);
  for (const id of peers) expect(w.runCheat(`~relation ${id} trust -5`).ok).toBe(true);
  return peers;
}
const fire = (w: World, id: string) => expect(w.runCheat(`~storylet ${id}`).ok).toBe(true);
const resolve = (w: World, choice: string) => w.executeTool("resolve_storylet", { choice_id: choice, improvised_move: null });

describe("무리 안의 신망", () => {
  it("같은 무리에서 주인공을 믿지 않는 사람을 센다", () => {
    const w = make();
    expect(standingInFaction(w.state(), content, me(w).id).distrust).toBe(0);
    distrustMe(w, 3);
    expect(standingInFaction(w.state(), content, me(w).id).distrust).toBe(3);
  });

  it("재판 이야기는 믿지 않는 사람이 셋 이상일 때만 열린다", () => {
    const w = make();
    const trial = content.storylets.pol_trial_low!;
    expect(conditionsMet(w.state(), content, trial, w.state().time)).toBe(false);
    distrustMe(w, 3);
    // 시간대 조건은 빼고 본다
    expect(conditionsMet(w.state(), content, { ...trial, when: { ...trial.when, segments: undefined } }, w.state().time)).toBe(true);
  });

  it("배역 distrusted_gte는 무리 안에서 믿음을 잃은 사람만 고른다", () => {
    const w = make();
    const role = { distrusted_gte: 2, faction: "own" } as Parameters<typeof castCandidates>[2];
    expect(castCandidates(w.state(), content, role)).toHaveLength(0);
    const [target, ...others] = factionPeers(w.state(), content, me(w).id);
    // 다른 두 사람이 target을 믿지 않게 (이야기 효과와 같은 이벤트)
    for (const id of others.slice(0, 2)) w.state().relations[id] = { ...(w.state().relations[id] ?? {}), [target!]: { trust: -5, affection: 0, respect: 0 } };
    expect(castCandidates(w.state(), content, role)).toContain(target);
  });
});

describe("쫓겨남과 강등", () => {
  it("재판에서 박차고 나가면 무리에서 쫓겨나 떠돌이가 된다", () => {
    const w = make();
    distrustMe(w, 3);
    fire(w, "pol_trial_low");
    const out = resolve(w, "walk_out");
    expect(out.ok).toBe(true);
    expect(me(w).factionId).toBe("");
    expect(me(w).rank).toBe(content.scenario.custom_start!.free_rank);
    expect(w.state().flags[me(w).id]).toContain("pol_expelled");
  });

  it("스스로 자리에서 내려오면 분대원이 된다", () => {
    const w = make("role_a_squad_leader");
    distrustMe(w, 3);
    fire(w, "pol_trial_high");
    expect(resolve(w, "step_down").ok).toBe(true);
    expect(me(w).rank).toBe("grunt");
    expect(me(w).factionId).toBe("faction_a");
  });
});
