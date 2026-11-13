import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createCharacterFromRole, createGameSchemas, createWorldEvent, rollAbilities } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import type { Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { TEST_CONTENT } from "../testing.ts";
import { gainMeritXp, levelForXp, xpForLevel } from "./growth.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.growth = { first: 10, step: 5, xp: { success: 1, partial: 1, miss: 2, merit: 2 }, daily_check_cap: 6 };
  c.scenario.ability_array = [2, 1, 0, 0, -1];
  c.scenario.charm = { ability: "persuasion", first_impression_per: 2, bonus_at: 2 };
  for (const f of Object.values(c.factions)) f.aggression = 0;
  return c;
}

function setup(c = content(), rng: Rng = () => 0) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx, content: c };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});
const check = (move = "fight", stat = "strength", difficulty = "normal") => act({ check: { move, stat, difficulty, harm_on_failure: "none", harm_cause: "" } });
const player = (env: ReturnType<typeof setup>) => env.store.getState().characters.player!;

describe("능력과 스킬", () => {
  it("역할에 능력이 없으면 능력 배열을 섞어 준다 (계급과 무관)", () => {
    const c = content();
    delete c.roles.role_test!.start_stats;
    const a = rollAbilities(c.scenario, () => 0.1);
    expect(Object.values(a).sort()).toEqual([-1, 0, 0, 1, 2]);
    const made = createCharacterFromRole(c.scenario, c.roles.role_test!, "player", () => 0.7);
    expect(Object.values(made.stats).sort()).toEqual([-1, 0, 0, 1, 2]);
  });

  it("스킬이 없으면 기본값, 역할의 시작 훈련은 그 값", () => {
    const c = content();
    c.scenario.moves[0]!.default = -1;
    c.roles.role_test!.start_skills = { stealth: 2 };
    const made = createCharacterFromRole(c.scenario, c.roles.role_test!);
    expect(made.skills).toMatchObject({ fight: -1, stealth: 2, search: 0 });
  });

  it("판정 보정은 능력 + 스킬 (상한까지) + 난이도 + 몸 상태", () => {
    const env = setup(content(), () => 0.5);
    player(env).skills.stealth = 2; // 민첩 2 + 은밀 2 = 4
    player(env).stats.agility = 3; // 3 + 2 = 5 → 상한 4
    const out = executeTool("take_action", check("stealth", "agility", "very_easy"), env.ctx);
    expect(out.ok && out.display.type === "check" && out.display.modifiers).toEqual({ stat: 3, skill: 1, difficulty: 2, condition: 0, trait: 0, gear: 0 });
  });
});

describe("경험치와 레벨업", () => {
  it("레벨마다 필요한 경험치가 5씩 는다 (10, 15, 20…)", () => {
    const s = content().scenario;
    expect([1, 2, 3].map((l) => xpForLevel(s, l))).toEqual([10, 25, 45]);
    expect(levelForXp(s, 9)).toBe(0);
    expect(levelForXp(s, 25)).toBe(2);
  });

  it("실패는 2, 성공은 1. 판정 경험치는 하루 6까지", () => {
    const env = setup(content(), () => 0); // 1+1 → 실패
    for (let i = 0; i < 5; i++) executeTool("take_action", check(), env.ctx);
    expect(player(env).xp).toBe(6);
    const s = env.store.getState();
    env.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + MINUTES_PER_DAY });
    executeTool("take_action", check(), env.ctx);
    expect(player(env).xp).toBe(8);
  });

  it("레벨이 오르면 GM에게 알리고, learn_skill로 스킬 하나를 올린다 (최고 단계까지)", () => {
    const env = setup(content(), () => 0);
    player(env).xp = 8;
    const out = executeTool("take_action", check(), env.ctx);
    expect(out.ok && out.resultText).toContain("레벨이 올랐다");
    expect(player(env)).toMatchObject({ level: 1, skillPoints: 1 });
    const learned = executeTool("learn_skill", { skill: "stealth" }, env.ctx);
    expect(learned.ok && learned.resultText).toContain("아마추어 +0 → 숙련 +1");
    expect(player(env)).toMatchObject({ skillPoints: 0, skills: { stealth: 1 } });
    expect(executeTool("learn_skill", { skill: "stealth" }, env.ctx).ok).toBe(false);
    player(env).skillPoints = 1;
    player(env).skills.stealth = 2;
    expect(executeTool("learn_skill", { skill: "stealth" }, env.ctx).ok).toBe(false);
  });

  it("공적 1당 경험치 2. 잃은 공적은 경험치를 빼지 않는다", () => {
    const env = setup();
    gainMeritXp(env.ctx, "player", 3);
    gainMeritXp(env.ctx, "player", -2);
    expect(player(env).xp).toBe(6);
  });

  it("growth가 없는 시나리오는 성장하지 않는다", () => {
    const c = content();
    delete c.scenario.growth;
    const env = setup(c, () => 0);
    executeTool("take_action", check(), env.ctx);
    expect(player(env).xp).toBe(0);
  });
});

describe("매력", () => {
  it("처음 만난 인물은 매력의 절반만큼 호감으로 시작한다", () => {
    const c = content();
    c.roles.role_test!.start_stats = { strength: 0, agility: 0, cool: 0, sense: 0, persuasion: 2 };
    const env = setup(c);
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, env.ctx);
    expect(env.store.getState().relations.npc_stranger?.player?.affection).toBe(1);
  });

  it("매력이 낮으면 첫인상 보정이 없다", () => {
    const env = setup(); // persuasion -1
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, env.ctx);
    expect(env.store.getState().relations.npc_stranger?.player).toBeUndefined();
  });
});

describe("이전 세이브", () => {
  it("옛 능력 id는 새 id로 옮기고, 빠진 능력은 0, 스킬은 기본값, 경험치는 0으로 읽는다", () => {
    const c = content();
    c.scenario.stats = c.scenario.stats.map((x) => (x.id === "persuasion" ? { ...x, id: "charm" } : x));
    c.scenario.stats.push({ id: "vitality", label: "체력" });
    c.scenario.renamed = { abilities: { persuasion: "charm" } };
    c.scenario.moves = c.scenario.moves.map((m) => (m.id === "persuade" ? { ...m, stats: ["charm"] } : m));
    c.scenario.charm = undefined;
    const old = createWorldEvent(TEST_CONTENT, "role_test", "w") as { player: Record<string, unknown> };
    const { skills: _s, xp: _x, level: _l, skillPoints: _p, ...bare } = old.player;
    const parsed = createGameSchemas(c.scenario).event.parse({ ...old, player: bare }) as { player: { stats: Record<string, number>; skills: Record<string, number>; xp: number } };
    expect(parsed.player.stats).toMatchObject({ charm: -1, vitality: 0, strength: 1 });
    expect(parsed.player.stats).not.toHaveProperty("persuasion");
    expect(parsed.player.skills.fight).toBe(0);
    expect(parsed.player.xp).toBe(0);
  });
});
