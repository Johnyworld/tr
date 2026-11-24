import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { afterCheckAmbush } from "./ambush.ts";
import { oppositionParts } from "./opposition.ts";

/** 매복 (12-177) */
const real = loadRealContent();
const content = { ...real, storylets: Object.fromEntries(Object.entries(real.storylets).filter(([id]) => ["rd_raider_ambush", "camp_ambush"].includes(id))) };
const make = (roll: number, role = "role_l_wanderer") => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ambush-")), content, rngFactory: () => () => roll }).create("mcp", role);
const chk = (move: string, stat: string, extra: Record<string, unknown> = {}) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close", ...extra });
const act = (w: GameWorld, input: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
function raider(w: GameWorld): string {
  expect(w.runCheat("~summon extra c_raider").ok).toBe(true);
  return Object.values(w.state().characters).filter((c) => c.extra?.template === "c_raider").at(-1)!.id;
}

describe("내 매복", () => {
  it("은밀 판정은 어렵게 굴리고, 성공하면 매복이 선다. 첫 공격에 +2가 붙고 매복은 끝난다", () => {
    const w = make(0.99);
    const r = act(w, { ambush: true, check: chk("stealth", "agility") });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toMatch(/-1\(어려움\)/);
    expect(w.state().ambush?.bonus).toBe(2);
    expect(w.sceneForGm()).toContain("매복 중");
    const foe = raider(w);
    const hit = act(w, { target: foe, check: chk("fight", "strength", { target_harm: "light" }) });
    expect(hit.ok, hit.ok ? "" : hit.error).toBe(true);
    expect(hit.ok && hit.resultText).toContain("+2(매복)");
    expect(w.state().ambush).toBeNull();
  });

  it("판정이 다르면 놓지 못하고, 실패하면 서지 않고, 구역을 떠나면 풀린다", () => {
    const w = make(0.99);
    expect(act(w, { ambush: true, check: chk("fight", "strength") }).ok).toBe(false);
    const miss = make(0);
    act(miss, { ambush: true, check: chk("stealth", "agility") });
    expect(miss.state().ambush).toBeNull();
    act(w, { ambush: true, check: chk("stealth", "agility") });
    const next = real.locations[w.state().playerZone!]!.adjacent[0]!;
    act(w, { move_to: next });
    expect(w.state().ambush).toBeNull();
  });

  it("매복이 상대를 흔들면, 혼란에 빠진 상대는 맞서지 못하고 실패해도 다치지 않는다", () => {
    const w = make(0.3); // 주사위가 낮아 실패한다
    const foe = raider(w);
    const state = w.state();
    // 매복이 선 채로 성공한 공격 뒤 (난수 0.1 < 혼란 확률)
    const ctx = { ...w.ctx(), rng: () => 0.1 };
    ctx.store.append({ type: "ambush_changed", ambush: { zone: state.playerZone!, until: state.time + 600, bonus: 2, confuse: true } });
    const lines = afterCheckAmbush(ctx, "fight", foe, "success", ctx.store.getState());
    expect(lines.join(" ")).toContain("허둥댄다");
    expect(w.state().confused).toContain(foe);
    expect(oppositionParts(content, w.state(), "fight", foe).some((p) => p.label.includes("근접전"))).toBe(false);
    const before = w.state().characters[w.state().playerId]!.conditions;
    const r = act(w, { target: foe, check: chk("fight", "strength", { harm_on_failure: "light", harm_cause: "약탈자의 반격", harm_kind: "blunt", opponent: foe }) });
    if (!r.ok) throw new Error(r.error);
    expect(r.resultText).toContain("반격하지 못했다");
    expect(w.state().characters[w.state().playerId]!.conditions).toEqual(before);
    expect(w.state().confused).not.toContain(foe);
  });
});

describe("적의 매복", () => {
  it("매복 이야기가 열리면 다음 판정 -2, 실패하면 혼란 (다음 판정 -1)", () => {
    const w = make(0.3);
    expect(w.runCheat("~storylet rd_raider_ambush").ok).toBe(true);
    expect(w.state().ambushed).not.toBeNull();
    expect(w.sceneForGm()).toContain("매복에 걸렸다");
    const r = act(w, { check: chk("sense_danger", "senses") });
    expect(r.ok && r.resultText).toContain("-2(매복당함)");
    expect(w.state().ambushed).toBeNull();
    expect(w.state().confused).toContain(w.state().playerId);
    const again = act(w, { check: chk("sense_danger", "senses") });
    expect(again.ok && again.resultText).toContain("-1(혼란)");
    expect(w.state().confused).not.toContain(w.state().playerId);
  });

  it("매복 이야기가 열린 채 판정을 걸고 다른 구역으로 달아날 수 있다 (12-302: 두 규칙이 서로 막았다)", () => {
    const w = make(0.99);
    expect(w.runCheat("~storylet rd_raider_ambush").ok).toBe(true);
    expect(w.state().activeStorylet).not.toBeNull();
    const next = real.locations[w.state().playerZone!]!.adjacent[0] ?? Object.values(real.locations).find((l) => l.adjacent.includes(w.state().playerZone!))!.id;
    // 판정 없이 걸어 나가거나 모른 척하면 막힌다
    expect(act(w, { move_to: next }).ok).toBe(false);
    expect(act(w, { move_to: next, ignore_story: true }).ok).toBe(false);
    const r = act(w, { move_to: next, check: chk("athletics", "agility") });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("냄새 맡기를 배운 개가 곁에 있으면 미리 알아챈다", () => {
    const w = make(0.99);
    let dog = w.state().companions.find((id) => w.state().characters[id]?.extra?.template === "stray_dog");
    if (!dog) {
      w.runCheat("~summon extra stray_dog");
      dog = Object.values(w.state().characters).find((c) => c.extra?.template === "stray_dog")!.id;
      w.ctx().store.append({ type: "companion_joined", characterId: dog, kind: "animal" });
    }
    w.ctx().store.append({ type: "trick_trained", animalId: dog, trick: "sniff", result: "learned", day: 1 });
    expect(w.runCheat("~storylet rd_raider_ambush").ok).toBe(true);
    expect(w.state().ambushed).toBeNull();
  });
});
