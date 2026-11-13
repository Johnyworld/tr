import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { joinRole } from "../game/customStart.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { initialWarWorld, rationLevel, simulateWarDay } from "../sim/war.ts";
import { WorldManager } from "../world/manager.ts";
import { squadFollowBonus, squadMembers } from "./command.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const SQUAD = ["a_dongwook", "a_byungchul", "a_yejin", "a_haneul"];

function open(roleId: string, rng: () => Rng = () => createSeededRng(4)) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-command-")), content, rngFactory: rng });
  return m.create("mcp", roleId, choice);
}

/** 시간을 흘린다 (그 사이 세계도 돌아간다. 주사위를 고정하면 기다림이 자주 끊겨 치트로 흘린다) */
function passHours(w: ReturnType<typeof open>, hours: number) {
  const r = w.runCheat(`~time +${hours}h`);
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
}

describe("분대 명령 (기획서 9.11)", () => {
  it("분대장은 분대원 넷이 있고, 장면에 분대 섹션과 맡길 수 있는 일이 나온다. 하급 전투원은 분대가 없다", () => {
    const w = open("role_a_squad_leader");
    expect(squadMembers(w.state(), w.content)).toEqual(SQUAD);
    const scene = w.sceneForGm();
    expect(scene).toContain("분대 (squad_order");
    expect(scene).toContain("guard 창고·초소 보초");
    const grunt = open("role_a_grunt");
    expect(grunt.sceneForGm()).not.toContain("분대 (squad_order");
    const r = grunt.executeTool("squad_order", { members: ["a_jiho"], task: "guard", zone: null });
    expect(r.ok).toBe(false);
    w.close();
    grunt.close();
  });

  it("일을 맡기면 그 시간 동안 장면에 들일 수 없고, 끝나면 코드가 굴린 결과가 보고로 돌아온다", () => {
    const w = open("role_a_squad_leader");
    const r = w.executeTool("squad_order", { members: ["a_byungchul"], task: "guard", zone: null });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().squadOrders.a_byungchul).toBeTruthy();
    const enter = w.executeTool("npc_presence", { npc_id: "a_byungchul", action: "enter" });
    expect(enter.ok).toBe(false);
    expect(w.sceneForGm()).toContain("창고·초소 보초 중");
    passHours(w, 7);
    expect(w.state().squadOrders.a_byungchul).toBeUndefined();
    expect(w.state().squadReports.a_byungchul?.text).toContain("보초");
    expect(w.sceneForGm()).toContain("마지막 보고");
    expect(w.executeTool("npc_presence", { npc_id: "a_byungchul", action: "enter" }).ok).toBe(true);
    w.close();
  });

  it("구역이 필요한 일은 구역 없이 맡길 수 없고, 같은 사람에게 두 가지를 맡길 수 없다", () => {
    const w = open("role_a_squad_leader");
    expect(w.executeTool("squad_order", { members: ["a_yejin"], task: "scout", zone: null }).ok).toBe(false);
    expect(w.executeTool("squad_order", { members: ["a_yejin"], task: "scout", zone: "old_town" }).ok).toBe(true);
    expect(w.executeTool("squad_order", { members: ["a_yejin"], task: "guard", zone: null }).ok).toBe(false);
    w.close();
  });

  it("분대장을 우습게 보는 분대원은 명령을 거절하고, 조금 못마땅하면 늑장을 부린다", () => {
    const w = open("role_a_squad_leader");
    const store = w.ctx().store;
    store.append({ type: "relation_changed", from: "a_dongwook", to: "player", delta: { trust: 0, affection: 0, respect: -2 }, reason: "test" });
    store.append({ type: "relation_changed", from: "a_haneul", to: "player", delta: { trust: 0, affection: 0, respect: -1 }, reason: "test" });
    const r = w.executeTool("squad_order", { members: ["a_dongwook", "a_haneul"], task: "guard", zone: null });
    expect(r.ok).toBe(true);
    expect(r.ok && r.resultText).toContain("명령을 따르지 않았다");
    expect(w.state().squadOrders.a_dongwook).toBeUndefined();
    const o = w.state().squadOrders.a_haneul!;
    expect(o.until - o.startedAt).toBe(9 * 60); // 6시간 × 1.5
    w.close();
  });

  it("곁에 둔 분대원은 따라오고, 싸움 판정에 보정을 준다", () => {
    const w = open("role_a_squad_leader");
    w.executeTool("npc_presence", { npc_id: "a_yejin", action: "enter" });
    expect(squadFollowBonus(w.state(), w.content, "shoot")).toBe(0);
    expect(w.executeTool("squad_order", { members: ["a_yejin"], task: "follow", zone: null }).ok).toBe(true);
    expect(w.state().companions).toContain("a_yejin");
    expect(squadFollowBonus(w.state(), w.content, "shoot")).toBe(1);
    expect(squadFollowBonus(w.state(), w.content, "persuade")).toBe(0);
    w.executeTool("take_action", act("동쪽 초소로 간다", { move_to: "a_east_post" }));
    expect(w.state().scene.present).toContain("a_yejin");
    w.close();
  });

  it("위험한 일이 틀어지면 분대원이 다치고 분대장을 덜 믿는다 (주사위가 늘 1)", () => {
    const w = open("role_a_squad_leader", () => () => 0);
    const harm = () => w.state().characters.a_haneul!.conditions[w.content.scenario.harm_track];
    const before = harm();
    expect(w.executeTool("squad_order", { members: ["a_haneul"], task: "search", zone: "riverside" }).ok).toBe(true);
    passHours(w, 6);
    expect(harm()).not.toBe(before);
    expect(w.state().relations.a_haneul?.player?.trust ?? 0).toBeLessThan(0);
    expect(w.state().squadReports.a_haneul?.text).toContain("빈손");
    w.close();
  });

  it("분대장이 죽고 분대원이 이어받으면, 그 사람은 분대장이 아니다 (자기 자신을 지휘하지 않는다)", () => {
    const w = open("role_a_squad_leader");
    expect(w.executeTool("squad_order", { members: ["a_yejin"], task: "guard", zone: null }).ok).toBe(true);
    w.runCheat("~kill me");
    expect(w.chooseNextCharacter("a_yejin", null).ok).toBe(true);
    expect(squadMembers(w.state(), w.content)).toEqual([]);
    expect(w.state().squadOrders).toEqual({});
    expect(w.sceneForGm()).not.toContain("분대 (squad_order");
    w.close();
  });

  it("스카우트로 같은 계급 자리에 오면 그 자리의 분대를 이어받는다", () => {
    const role = joinRole(content, "faction_a", "squad_leader", { age: 30 });
    expect(role.squad).toEqual(SQUAD);
    expect(joinRole(content, "faction_a", "grunt", { age: 30 }).squad).toBeUndefined();
  });
});

describe("지도부 회의 (기획서 9.11)", () => {
  it("간부는 상관이 있을 때 안을 올린다. 받아들여지면 무리 방침이 바뀌고 배급 단계가 달라진다 (주사위가 늘 6)", () => {
    const w = open("role_a_officer", () => () => 0.999);
    const propose = { topic: "ration", option: "cut", approach: "persuade", stat: "charm", intent: "겨울까지 버티려면 줄여야 한다" };
    expect(w.sceneForGm()).toContain("무리 방침: 배급 보통 · 태세 보통");
    expect(w.executeTool("council_propose", propose).ok).toBe(false); // 상관이 장면에 없다
    w.executeTool("npc_presence", { npc_id: "a_seonghee", action: "enter" });
    const before = rationLevel(w.content, w.state().factions.faction_a!);
    const r = w.executeTool("council_propose", propose);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().factions.faction_a!.policy).toEqual({ ration: "cut" });
    expect(w.sceneForGm()).toContain("배급 줄이기");
    const after = rationLevel(w.content, w.state().factions.faction_a!);
    const levels = w.content.scenario.war!.ration.levels;
    expect(levels.indexOf(after)).toBe(Math.min(levels.length - 1, levels.indexOf(before) + 1));
    // 같은 주제는 하루 한 번
    expect(w.executeTool("council_propose", { ...propose, option: "extra" }).ok).toBe(false);
    w.close();
  });

  it("기각되면 사흘 동안 같은 주제를 다시 올리지 못한다. 하급 전투원은 회의에 앉지 않는다 (주사위가 늘 1)", () => {
    const w = open("role_a_officer", () => () => 0);
    w.executeTool("npc_presence", { npc_id: "a_seonghee", action: "enter" });
    const r = w.executeTool("council_propose", { topic: "stance", option: "attack", approach: "tactics", stat: "intellect", intent: "먼저 친다" });
    expect(r.ok && r.resultText).toContain("받아들이지 않았다");
    expect(w.state().factions.faction_a!.policy).toBeUndefined();
    expect(w.state().council.stance!.blockedUntil).toBeGreaterThan(w.state().time);
    const grunt = open("role_a_grunt");
    grunt.executeTool("npc_presence", { npc_id: "a_taeho", action: "enter" });
    expect(grunt.executeTool("council_propose", { topic: "stance", option: "attack", approach: "tactics", stat: "intellect", intent: "x" }).ok).toBe(false);
    expect(grunt.sceneForGm()).toContain("무리 방침");
    expect(grunt.sceneForGm()).not.toContain("council_propose");
    w.close();
    grunt.close();
  });

  it("방침은 전쟁 틱에 닿는다: 배급을 줄이면 식량이 덜 줄고, 밀어붙이면 더 자주 치러 나간다", () => {
    const base = initialWarWorld(content);
    const food = (policy?: Record<string, string>) => {
      const world = structuredClone(base);
      world.factions.faction_a!.policy = policy;
      return simulateWarDay(world, content, createSeededRng(1)).factions.faction_a!.resources.food!;
    };
    expect(food({ ration: "cut" })).toBeGreaterThan(food());
    expect(food({ ration: "extra" })).toBeLessThan(food());

    const attacks = (policy?: Record<string, string>) => {
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const world = structuredClone(base);
        world.factions.faction_c!.policy = policy;
        n += simulateWarDay(world, content, createSeededRng(seed)).clashes.filter((c) => c.attacker === "faction_c").length;
      }
      return n;
    };
    expect(attacks({ stance: "attack" })).toBeGreaterThan(attacks());
    expect(attacks({ stance: "defend" })).toBeLessThan(attacks());
  });
});
