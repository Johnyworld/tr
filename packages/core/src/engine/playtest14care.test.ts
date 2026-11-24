import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { rollPlayerCheck } from "./checks.ts";
import { fireStorylet } from "./storyletTools.ts";
import { checkNpcBodies, checkStorylets } from "../content/loader.ts";
import { threatInScene } from "../rules/situation.ts";
import { playerCalls } from "../game/acquaintance.ts";

/** 플레이 테스트 14 (docs/playtests/2026-11-22-mcp-14.md) 치료·위협·판정 묶음 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, rng: () => () => number = () => createSeededRng(5)) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt14c-")), content, rngFactory: rng });
  return m.create("mcp", roleId, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});
const check = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const levelOf = (track: string, i: number) => content.scenario.condition_tracks.find((t) => t.id === track)!.levels[i]!.id;
const indexOf = (track: string, id: string | undefined) => content.scenario.condition_tracks.find((t) => t.id === track)!.levels.findIndex((l) => l.id === id);

describe("플레이 테스트 14: 치료", () => {
  // 의무 T57: 붕대·맨손 모두 "수술을 배우지 않아 손댈 수 없다"로 거절됐다
  function patient(bleeds: boolean) {
    const w = world("role_d_medic", () => () => 0.99);
    const ctx = w.ctx();
    const me = w.state().characters[w.state().playerId]!;
    delete me.skills[content.scenario.recovery!.surgery!.move];
    const tpl = Object.entries(content.extras).find(([, t]) => t.kind !== "infected" && t.kind !== "animal")![0];
    const r0 = w.executeTool("spawn_extra", { template: tpl, label: "깔렸던 동료" });
    expect(r0.ok, r0.ok ? "" : r0.error).toBe(true);
    const id = w.state().scene.present.find((x) => w.state().characters[x]?.name === undefined || x.startsWith("ex_"))!;
    const harm = content.scenario.harm_track;
    changeCondition(ctx, id, harm, indexOf(harm, content.scenario.recovery!.surgery!.from), "cheat", "테스트");
    if (bleeds) changeCondition(ctx, id, content.scenario.wounds!.track, 3, "cheat", "테스트");
    return { w, id };
  }

  it("수술을 몰라도 치명상 동료의 피는 멎게 한다", () => {
    const { w, id } = patient(true);
    const move = content.scenario.wounds!.staunch_move;
    const stat = content.scenario.moves.find((m) => m.id === move)!.stats[0]!;
    const r = w.executeTool("take_action", act({ treatment: { item: null, target: id }, check: check(move, stat) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().characters[id]!.conditions[content.scenario.wounds!.track]).toBe(levelOf(content.scenario.wounds!.track, 0));
    expect(r.ok && r.resultText).toContain("수술감");
    expect(w.state().characters[id]!.conditions[content.scenario.harm_track]).toBe(content.scenario.recovery!.surgery!.from);
  });

  it("피가 안 나는 치명상이면 지혈할 피가 없다는 것과 지혈은 누구나 한다는 것을 알린다", () => {
    const { w, id } = patient(false);
    const move = content.scenario.wounds!.staunch_move;
    const stat = content.scenario.moves.find((m) => m.id === move)!.stats[0]!;
    const r = w.executeTool("take_action", act({ treatment: { item: null, target: id }, check: check(move, stat) }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("멎게 할 피가 흐르지 않는다");
    expect(r.ok ? "" : r.error).toContain("수술을 몰라도");
  });
});

describe("플레이 테스트 14: 이야기의 피해", () => {
  it("'꺼진 바닥'에서 구하러 간 대가 있는 성공은 깔린 상처에 한 단계까지, 두고 가기보다 덜 다친다", () => {
    const s = content.storylets.occ_sc_pinned_mate!;
    const hurt = (effects: readonly object[]) => effects.reduce((n, e) => n + ("npc_hurt" in e ? (e as { npc_hurt: { steps: number } }).npc_hurt.steps : 0), 0);
    const leave = hurt(s.choices.find((c) => c.id === "leave")!.effects);
    for (const c of s.choices.filter((x) => x.check)) {
      expect(hurt(c.outcomes!.success)).toBeLessThan(leave);
      expect(hurt(c.outcomes!.partial)).toBeLessThanOrEqual(1);
    }
    expect(checkStorylets(content)).toEqual([]);
  });

  it("content:check는 구하러 간 대가 있는 성공이 두고 가기만큼 다치게 하면 잡는다", () => {
    const s = content.storylets.occ_sc_pinned_mate!;
    const bad = {
      ...s,
      choices: s.choices.map((c) => (c.id === "lift" ? { ...c, outcomes: { ...c.outcomes!, partial: [...c.outcomes!.partial.filter((e) => !("npc_hurt" in e)), { npc_hurt: { who: "mate", steps: 2 } }] } } : c)),
    };
    const problems = checkStorylets({ ...content, storylets: { [s.id]: bad } } as never);
    expect(problems.some((p) => p.includes("choices.lift.partial"))).toBe(true);
  });

  it("판정 결과가 정한 마음의 대가는 마음 다잡기로 다시 굴리지 않는다", () => {
    // 방문자 T66: 다리 건너기 대가 있는 성공 뒤 버티기 판정이 또 나와 대가를 지웠다
    const w = world("role_a_grunt", () => () => 0.99);
    const ctx = w.ctx();
    fireStorylet(ctx, content.storylets.rd_broken_bridge!, {});
    const st = w.state();
    ctx.store.append({
      type: "check_rolled", checkId: `chk_${st.nextCheckNo}`, turn: st.turn, actorId: st.playerId, move: "athletics", stat: "strength", difficulty: "normal", intent: "판자를 건넌다",
      dice: [4, 4], modifiers: { stat: 0, skill: 0, difficulty: 0, condition: 0, trait: 0, gear: 0, opposition: 0 }, total: 8, outcome: "partial",
    } as never);
    const nerves = content.scenario.body!.nerves!.track;
    const before = indexOf(nerves, w.state().characters[st.playerId]!.conditions[nerves]);
    const r = w.executeTool("resolve_storylet", { choice_id: "cross" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).not.toContain("마음을 다잡았다");
    expect(indexOf(nerves, w.state().characters[st.playerId]!.conditions[nerves])).toBe(before + 1);
  });
});

describe("플레이 테스트 14: 위협", () => {
  it("무력화된 감염체는 곁의 위협이 아니라 수색을 막지 않는다", () => {
    // 경비 T10
    const w = world("role_a_grunt");
    const tpl = Object.entries(content.extras).find(([, t]) => t.kind === "infected")![0];
    expect(w.executeTool("spawn_extra", { template: tpl, label: "기어다니는 감염체" }).ok).toBe(true);
    const id = threatInScene(w.state(), content)[0]!;
    expect(id).toBeTruthy();
    const harm = content.scenario.harm_track;
    changeCondition(w.ctx(), id, harm, indexOf(harm, content.scenario.combat!.incapacitated_at), "cheat", "테스트");
    expect(threatInScene(w.state(), content)).toEqual([]);
    const r = w.executeTool("take_action", act({ activity: { kind: "search", until: null } }));
    expect(r.ok ? "" : r.error).not.toContain("곁에 위협이 있다");
  });
});

describe("플레이 테스트 14: 인물의 시작 몸 상태", () => {
  it("다리를 다친 정찰조장은 다친 채 열에 들떠 시작한다", () => {
    const w = world("role_a_grunt");
    const c = w.state().characters.a_gicheol_scout!;
    expect(indexOf(content.scenario.harm_track, c.conditions[content.scenario.harm_track])).toBeGreaterThan(0);
    expect(c.conditions[content.scenario.body!.disease!.track]).toBe("sick");
  });

  it("content:check는 카드 글이 다쳤다는데 시작 상태가 없으면 잡는다", () => {
    expect(checkNpcBodies(content)).toEqual([]);
    const n = content.npcs.a_gicheol_scout!;
    const bare = { ...n, starts: undefined };
    const problems = checkNpcBodies({ ...content, npcs: { [n.id]: bare } } as never);
    expect(problems.some((p) => p.includes("starts.harm"))).toBe(true);
    expect(problems.some((p) => p.includes("starts.disease"))).toBe(true);
  });
});

describe("플레이 테스트 14: 판정 보정", () => {
  it("구해 주는 분대원을 target으로 두어도 맞서는 상대가 아니다", () => {
    // 분대장 T16: "+1(상대가 근접전에 서툶: 노병철)"
    const w = world("role_a_squad_leader");
    const mate = content.roles.role_a_squad_leader!.squad![0]!;
    w.ctx().store.append({ type: "companion_joined", characterId: mate, kind: "squad" } as never);
    const r = rollPlayerCheck({ move: "fight", stat: "strength", difficulty: "normal", intent: "끌어내린다" }, w.ctx(), { target: mate, stakes: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.display.line).not.toMatch(/상대가|의 근접전/);
    // 내 편이 아닌 사람은 그대로 상대다
    const tpl = Object.entries(content.extras).find(([, t]) => t.kind !== "infected" && t.kind !== "animal")![0];
    expect(w.executeTool("spawn_extra", { template: tpl, label: "덤비는 사람" }).ok).toBe(true);
    const foe = w.state().scene.present.find((x) => x.startsWith("ex_"))!;
    const r2 = rollPlayerCheck({ move: "fight", stat: "strength", difficulty: "normal", intent: "친다" }, w.ctx(), { target: foe, stakes: true });
    expect(r2.ok && r2.display.line).toContain(playerCalls(w.state(), content, foe));
  });

  it("with로 함께하는 사람은 target이어도 맞서는 상대가 아니고, 잘하면 판정을 돕는다 (여울섬 T71: 같이 숨은 설다빈)", () => {
    const w = world("role_a_grunt");
    const tpl = Object.entries(content.extras).find(([, t]) => t.kind !== "infected" && t.kind !== "animal")![0];
    expect(w.executeTool("spawn_extra", { template: tpl, label: "같이 숨는 사람" }).ok).toBe(true);
    const mate = w.state().scene.present.find((x) => x.startsWith("ex_"))!;
    w.state().characters[mate]!.skills.stealth = 2;
    const alone = rollPlayerCheck({ move: "stealth", stat: "agility", difficulty: "normal", intent: "숨는다" }, w.ctx(), { target: mate, stakes: true });
    expect(alone.ok && alone.display.line).toContain("상대가");
    const together = rollPlayerCheck({ move: "stealth", stat: "agility", difficulty: "normal", intent: "숨는다" }, w.ctx(), { target: mate, allies: [mate], stakes: true });
    expect(together.ok && together.display.line).not.toContain("상대가");
    expect(together.ok && together.display.line).toContain("도움");
  });

  it("뒤지며 굴린 수색 아닌 판정에는 수색할 곳의 보정이 붙지 않는다", () => {
    // 분대장 T24: 생존 판정에 "+1(넉넉한 곳) +1(역사)"
    const w = world("role_a_grunt");
    const zone = Object.values(content.locations).find((l) => l.loot && l.loot.modifier !== 0 && !l.owner)!;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: zone.id });
    w.state().characters[w.state().playerId]!.skills.history = 1;
    const search = content.scenario.exploration!.search_move;
    const other = content.scenario.moves.find((m) => m.id !== search && m.category === content.scenario.moves.find((x) => x.id === search)!.category && m.kind !== "expert")!;
    const r = w.executeTool("take_action", act({ ignore_story: true, activity: { kind: "search", until: null }, check: check(other.id, other.stats[0]!) }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).not.toMatch(/뒤질 거리가 많은 구역|털린 구역|옛 건물 쓰임/);
    const r2 = w.executeTool("take_action", act({ ignore_story: true, activity: { kind: "search", until: null }, check: check(search, content.scenario.moves.find((m) => m.id === search)!.stats[0]!) }));
    expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
    expect(r2.ok && r2.resultText).toMatch(/뒤질 거리가 많은 구역|털린 구역/);
  });
});
