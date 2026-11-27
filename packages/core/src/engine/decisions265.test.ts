import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldOf, heldSeenTopic } from "../rules/held.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { capturePlayer } from "./captivity.ts";
import { createSeededRng } from "../rng.ts";
import { describeInfiltration } from "./infiltration.ts";

/** 플레이 테스트 18 뒤 고친 것 (12-265). 실제 경로(세계 만들기·도구 호출·하루가 지나는 셈)로 본다 */
const content = loadRealContent();
const make = (roleId: string, extra: Record<string, unknown> = {}, roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-265-")), content, rngFactory: () => () => roll }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [], ...extra } as never);
type W = ReturnType<typeof make>;
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const mateHere = (w: W, faction: string) => Object.values(content.npcs).find((n) => n.faction === faction && n.id !== w.state().playerId && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && !heldOf(w.state().characters[n.id]))!.id;
const hunger = content.scenario.body!.hunger!.track;

describe("판정과 행적 (12-265)", () => {
  it("행동의 대상은 그 판정을 돕지 않는다", () => {
    const w = make("role_a_grunt");
    const mate = mateHere(w, "faction_a");
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    const melee = content.scenario.gear!.attack_moves[0]!;
    const r = w.executeTool("take_action", act({ target: mate, check: { move: melee, stat: "strength", difficulty: "normal", harm_on_failure: "none" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const name = w.state().characters[mate]!.name;
    expect(JSON.stringify(r)).not.toContain(`${name}이 도움`);
    expect(JSON.stringify(r)).not.toContain(`${name}가 도움`);
  });

  it("거짓말에 속는 사람은 거짓말을 들은 상대뿐이다", () => {
    const w = make("role_a_grunt");
    const [a, b] = Object.values(content.npcs).filter((n) => n.faction === "faction_a" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && !heldOf(w.state().characters[n.id])).map((n) => n.id);
    w.executeTool("npc_presence", { npc_id: a!, action: "enter" });
    w.executeTool("npc_presence", { npc_id: b!, action: "enter" });
    const r = w.executeTool("take_action", act({ check: { move: content.scenario.move_roles.deceive, stat: "charm", difficulty: "normal", harm_on_failure: "none", opponent: a }, with: [b], deed: { summary: "찢은 그물을 두고 둘러대 감쌌다", tags: ["deceit"], severity: 1, privacy: "semi_private", noisy: false, condition: "on_success" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const deed = Object.values(w.state().deeds).at(-1)!;
    if (r.ok && r.resultText?.includes("속아 넘어가")) expect(deed.witnesses.some((x) => x.npcId === b)).toBe(true);
  });
});

describe("부탁·불려 감 (12-265)", () => {
  it("꺼내지 않은 부탁의 물건을 transfer_item으로 건네면 받아 주고 지킨 것이다", () => {
    const w = make("role_a_grunt");
    const jiho = "a_jiho";
    w.ctx().store.append({ type: "promise_asked", id: "p_1", by: w.state().playerId, to: jiho, what: "소총탄", due: 99, item: { id: "rifle_rounds", quantity: 1 }, favor: "rounds_for_scouting" });
    w.runCheat("~give rifle_rounds 1");
    w.executeTool("npc_presence", { npc_id: jiho, action: "enter" });
    const r = w.executeTool("transfer_item", { from: w.state().playerId, to: jiho, item_id: "rifle_rounds", quantity: 1 });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().promises.find((p) => p.id === "p_1")?.status).toBe("kept");
  });
});

describe("포로 (12-265)", () => {
  it("행방을 모르는 우리 무리 포로는 잠입 목표로 드러나지 않고, 그곳에 있다고 알면 드러난다", () => {
    const w = make("role_a_grunt");
    const captive = Object.values(w.state().characters).find((c) => c.factionId === "faction_a" && heldOf(c))!;
    expect(captive).toBeTruthy();
    w.runCheat(`~goto ${heldOf(captive)!.zone}`);
    expect(describeInfiltration(content, w.state()).join(" ")).not.toContain("free");
    const s = w.state();
    w.ctx().store.append({ type: "belief_added", characterId: s.playerId, belief: { id: `b_${s.nextBeliefNo}`, fact: "갇혀 있다고 한다", source: "report", accuracy: "approximate", learnedAt: s.time, topic: heldSeenTopic(captive.id, heldOf(captive)!.zone) } });
    expect(describeInfiltration(content, w.state()).join(" ")).toContain("free");
  });

  it("갇힌 동안 이야기 효과도 허기 바닥을 넘지 않는다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    w.runCheat(`~set ${hunger} ${content.scenario.captivity!.hunger_floor}`);
    w.runCheat("~storylet cp_c_labor");
    w.executeTool("resolve_storylet", { choice_id: "listen" });
    expect(w.state().characters[w.state().playerId]!.conditions[hunger]).toBe(content.scenario.captivity!.hunger_floor);
  });

  it("갇혀서 자고 나면 같이 갇힌 사람만 장면에 남는다", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    const guard = mateHere(w, "faction_c");
    w.runCheat("~time night");
    w.executeTool("npc_presence", { npc_id: guard, action: "enter" });
    const slept = w.executeTool("take_action", act({ activity: { kind: "sleep", until: null, hours: 8 } }));
    expect(slept.ok, slept.ok ? "" : slept.error).toBe(true);
    const cast = Object.values(w.state().activeStorylet?.cast ?? {});
    if (!cast.includes(guard)) expect(w.state().scene.present).not.toContain(guard);
  });

  it("이야기로 풀려나 거점에 닿으면 못 받은 배급을 그 결과에서 받는다 (다음 행동이 거절돼도 말없이 바뀌지 않는다)", () => {
    const w = make("role_a_grunt");
    capturePlayer(w.ctx(), "faction_c");
    w.ctx().store.append({ type: "ration_missed", day: Math.floor(w.state().time / (24 * 60)) });
    w.runCheat("~storylet cp_long_ransom");
    w.executeTool("resolve_storylet", { choice_id: "go_home" });
    expect(w.state().missedRationDay).toBeNull();
  });
});

describe("세계 만들기·즉흥 자리·겉모습 (12-265)", () => {
  it("시작 짐에서 내려놓은 것은 시작 자리 바닥에 남고, 주인공이 안다", () => {
    // PT18 튜토리얼과 같은 캐릭터·시드 (짐이 한도를 넘었다). 착용한 것도 무게 그대로 셀 때 (worn_factor 1)
    const gear = content.scenario.gear!;
    const heavy = { ...content, scenario: { ...content.scenario, gear: { ...gear, carry: { ...gear.carry, worn_factor: 1 } } } };
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-265-")), content: heavy, rngFactory: () => createSeededRng(17) }).create("mcp", "role_t_visitor", { name: "민재", gender: "male", past: "courier", persona: { talk: 2, principle: 1 }, settings: ["flaw_greedy", "secret_debt_owed"], abilities: null, portrait: null, traits: [] } as never);
    const s = w.state();
    expect((s.beliefs[s.playerId] ?? []).some((b) => b.fact.startsWith("짐이 무거워"))).toBe(true);
    expect(Object.values(s.scene.items).some((n) => n > 0)).toBe(true);
  });

  it("다른 이야기가 열려도 즉흥 자리는 기한까지 남는다", () => {
    const w = make("role_a_grunt");
    const store = w.ctx().store;
    store.append({ type: "improv_slot_opened", expiresAt: w.state().time + 600 });
    w.runCheat("~storylet cp_long_wall");
    expect(w.state().improvSlot).not.toBeNull();
  });

  it("같은 틀 엑스트라를 셋 만들어도 겉모습이 겹치지 않는다", () => {
    const w = make("role_y_islander");
    const looks = ["가", "나", "다"].map((label) => {
      const r = w.executeTool("spawn_extra", { template: "y_quarantine_waiter", label, gender: null, age: null });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      return Object.values(w.state().characters).find((c) => c.extra?.label === label)!.extra!.look;
    });
    expect(new Set(looks).size).toBe(3);
  });
});
