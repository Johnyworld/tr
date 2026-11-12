import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runCommand } from "../commands/commands.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

const sixes: Rng = () => 0.99;

/** 낌새(이상 징후) 없이, 원하면 C의 클락이 하루 만에 차게 */
function content(options: { planDays?: number } = {}): Content {
  const c = structuredClone(TEST_CONTENT);
  for (const key of Object.keys(c.scenario.threats.disturbance_chance_per_hour)) {
    (c.scenario.threats.disturbance_chance_per_hour as Record<string, number>)[key] = 0;
  }
  // 교전은 클락으로만 (평소 공격 끔)
  for (const f of Object.values(c.factions)) f.aggression = 0;
  if (options.planDays) c.factions.faction_c!.plans[0]!.days = options.planDays;
  return c;
}

function setup(c: Content = content(), rng: Rng = createSeededRng(5)) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx };
}

const act = (input: Record<string, unknown>) => ({
  intent: "행동",
  check: null,
  activity: null,
  deed: null,
  target: null,
  narration_summary: null,
  for_mission: false,
  ...input,
});

const check = (move: string, stat: string, harm: "none" | "light" | "heavy" = "light") => ({
  move,
  stat,
  difficulty: "normal",
  harm_on_failure: harm,
  harm_cause: harm === "none" ? "" : "적의 반격",
});

/** 초소(a_post)를 노리는 교전을 지금부터 30분 뒤로 예정한다 */
function scheduleAssault(env: ReturnType<typeof setup>, minutesFromNow = 30) {
  const s = env.store.getState();
  env.store.append({
    type: "war_day_simulated",
    day: (s.lastWarDay ?? 1) + 1,
    factions: s.factions,
    zones: s.zones,
    clocks: {},
    clashes: [],
    scheduled: [{ id: "battle_1", kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_post", at: s.time + minutesFromNow }],
  });
}

function goToPost(env: ReturnType<typeof setup>) {
  expect(executeTool("take_action", act({ move_to: "a_post" }), env.ctx).ok).toBe(true);
}

function waitUntilBattle(env: ReturnType<typeof setup>) {
  for (let i = 0; i < 20 && !env.store.getState().battle; i++) executeTool("take_action", act({ activity: { kind: "talk", until: null } }), env.ctx);
  expect(env.store.getState().battle).not.toBeNull();
}

describe("구역과 이동", () => {
  it("시작 구역은 소속 세력의 거점이다", () => {
    expect(setup().store.getState().playerZone).toBe("a_home");
  });

  it("맞닿은 구역으로만 옮기고, 30~60분이 든다", () => {
    const env = setup();
    const before = env.store.getState().time;
    const bad = executeTool("take_action", act({ move_to: "c_home" }), env.ctx);
    expect(bad.ok).toBe(false);
    goToPost(env);
    const s = env.store.getState();
    expect(s.playerZone).toBe("a_post");
    expect(s.time - before).toBeGreaterThanOrEqual(30);
    expect(s.time - before).toBeLessThanOrEqual(60);
    expect(runCommand("!지도", { state: s, content: TEST_CONTENT, summaries: [] })).toContain("현재  초소 · 우리 무리");
  });
});

describe("준비물", () => {
  it("우리 구역에서 재료와 판정이 있어야 설치된다. 재료는 쓴다", () => {
    const env = setup(content(), sixes);
    const noItem = executeTool("take_action", act({ prepare: "snare", check: check("search", "sense", "none") }), env.ctx);
    expect(noItem.ok).toBe(false);
    env.store.getState().characters.player!.inventory.rope = 1;
    expect(executeTool("take_action", act({ prepare: "snare" }), env.ctx).ok).toBe(false); // 판정 없음
    const out = executeTool("take_action", act({ prepare: "snare", check: check("search", "sense", "none") }), env.ctx);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.preparations.a_home).toEqual(["snare"]);
    expect(s.characters.player!.inventory.rope).toBeUndefined();
  });
});

describe("예정된 교전", () => {
  it("그 자리에 있으면 전투 장면이 열린다. 열리기 전에는 아무 데도 드러나지 않는다", () => {
    const env = setup();
    goToPost(env);
    scheduleAssault(env);
    const s = env.store.getState();
    const before = [describePlayerState(s, TEST_CONTENT), runCommand("!세력", { state: s, content: TEST_CONTENT, summaries: [] })].join("\n");
    expect(before).not.toMatch(/battle_1|전투 중|덮쳤다/);
    waitUntilBattle(env);
    const b = env.store.getState().battle!;
    expect(b).toMatchObject({ side: "defense", zone: "a_post", attacker: "faction_c", round: 0 });
    expect(env.store.getState().pendingClashes).toEqual([]);
    expect(describePlayerState(env.store.getState(), TEST_CONTENT)).toContain("전투 중: 초소 전투 (방어)");
  });

  it("자리를 떴으면 화면 밖에서 계산하고 보고만 듣는다", () => {
    const env = setup();
    scheduleAssault(env); // 플레이어는 거점에 있다
    for (let i = 0; i < 4; i++) executeTool("take_action", act({ activity: { kind: "talk", until: null } }), env.ctx);
    const s = env.store.getState();
    expect(s.battle).toBeNull();
    expect(env.store.events().some((e) => e.type === "clash_resolved")).toBe(true);
    expect((s.beliefs.player ?? []).some((b) => b.topic === "war" && b.fact.includes("초소"))).toBe(true);
  });

  it("잠든 사이 새벽 교전이 오면 잠이 그 시각에 깬다 (자정에 하루 틱을 돌리고 이어 간다)", () => {
    const env = setup(content({ planDays: 1 }));
    goToPost(env);
    // 저녁까지 기다렸다가 아침까지 잔다
    executeTool("take_action", act({ activity: { kind: "wait", until: "night" } }), env.ctx);
    const out = executeTool("take_action", act({ activity: { kind: "sleep", until: "morning" } }), env.ctx);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.battle).not.toBeNull();
    const minute = s.time % (24 * 60);
    expect(minute).toBeGreaterThanOrEqual(240);
    expect(minute).toBeLessThanOrEqual(330);
    expect(out.ok && [out.display, ...(out.extra ?? [])].some((d) => d.type === "battle" && d.event === "started")).toBe(true);
  });
});

describe("전투 라운드", () => {
  function inBattle(rng: Rng = sixes) {
    const env = setup(content(), rng);
    goToPost(env);
    scheduleAssault(env);
    waitUntilBattle(env);
    return env;
  }

  it("전투 효과에는 판정과 효과별 최소 위험이 필요하고, 긴 활동·이동은 할 수 없다", () => {
    const env = inBattle();
    expect(executeTool("take_action", act({ battle: { effect: "brawl", objective: null } }), env.ctx).ok).toBe(false);
    expect(
      executeTool("take_action", act({ battle: { effect: "brawl", objective: null }, check: check("fight", "strength", "none") }), env.ctx).ok,
    ).toBe(false);
    expect(executeTool("take_action", act({ activity: { kind: "sleep", until: null } }), env.ctx).ok).toBe(false);
    expect(executeTool("take_action", act({ move_to: "a_home" }), env.ctx).ok).toBe(false);
    expect(executeTool("take_action", act({ battle: { effect: "backstab", objective: null }, check: check("fight", "strength") }), env.ctx).ok).toBe(
      false,
    ); // 아직 전선
    // 숨어들기는 최소 위험이 none (대가는 경보로 온다)
    expect(
      executeTool("take_action", act({ battle: { effect: "creep", objective: null }, check: check("stealth", "agility", "none") }), env.ctx).ok,
    ).toBe(true);
  });

  it("한 행동이 한 라운드(10분)다. 숨어들어 뒤에서 폭탄을 터뜨리면 목표물이 무너지고 폭탄을 쓴다", () => {
    const env = inBattle();
    env.store.getState().characters.player!.inventory.bomb = 1;
    const t0 = env.store.getState().time;
    expect(executeTool("take_action", act({ battle: { effect: "creep", objective: null }, check: check("stealth", "agility") }), env.ctx).ok).toBe(true);
    let s = env.store.getState();
    expect(s.time - t0).toBe(10);
    expect(s.battle).toMatchObject({ round: 1, position: "back" });
    const out = executeTool("take_action", act({ battle: { effect: "blast", objective: "boss" }, check: check("fight", "agility", "heavy") }), env.ctx);
    expect(out.ok).toBe(true);
    s = env.store.getState();
    expect(s.characters.player!.inventory.bomb).toBeUndefined();
    if (s.battle) expect(s.battle.objectives).toEqual(["stash"]);
    else expect(env.store.events().find((e) => e.type === "battle_round" && e.effect === "blast")).toMatchObject({ objectives: ["stash"] });
  });

  it("끝나면 결과가 세력 상태에 들어가고, 활약만큼 공적과 보고가 남는다", () => {
    const env = inBattle();
    const combatantsBefore = env.store.getState().factions.faction_c!.combatants;
    for (let i = 0; i < 10 && env.store.getState().battle; i++) {
      const s = env.store.getState();
      const effect = s.battle!.position === "front" ? "creep" : "backstab";
      executeTool("take_action", act({ battle: { effect, objective: null }, check: check(effect === "creep" ? "stealth" : "fight", "agility") }), env.ctx);
    }
    const s = env.store.getState();
    expect(s.battle).toBeNull();
    const ended = env.store.events().find((e) => e.type === "battle_ended");
    expect(ended).toMatchObject({ won: true, withdrew: false });
    expect(s.factions.faction_c!.combatants).toBeLessThan(combatantsBefore);
    expect(s.zones.a_post?.owner).toBe("faction_a"); // 막아 냈다
    expect(ended && ended.type === "battle_ended" && ended.merit).toBeGreaterThan(0);
    expect(s.characters.player!.merit).toBeGreaterThan(0);
    expect((s.beliefs.player ?? []).some((b) => b.topic === "war" && b.source === "report")).toBe(true);
    // 공이 크면 용기 있는 행적으로 남는다
    expect(Object.values(s.deeds).some((d) => d.tags.includes("bravery"))).toBe(true);
  });

  it("덫은 그 구역에 설치해 둔 것만 쓰고, 쓰면 사라진다", () => {
    const env = setup(content(), sixes);
    goToPost(env);
    env.store.getState().characters.player!.inventory.rope = 1;
    executeTool("take_action", act({ prepare: "snare", check: check("search", "sense", "none") }), env.ctx);
    scheduleAssault(env, 60);
    waitUntilBattle(env);
    expect(executeTool("take_action", act({ battle: { effect: "pull_snare", objective: null }, check: check("fight", "agility") }), env.ctx).ok).toBe(true);
    expect(env.store.getState().preparations.a_post).toEqual([]);
  });

  it("물러나면 남은 싸움은 코드가 굴려 끝낸다", () => {
    const env = inBattle();
    executeTool("take_action", act({ battle: { effect: "run", objective: null }, check: check("endure", "cool") }), env.ctx);
    expect(env.store.getState().battle).toBeNull();
    expect(env.store.events().find((e) => e.type === "battle_ended")).toMatchObject({ withdrew: true });
  });

  it("판정 없이 지나간 턴도 한 라운드가 흐른다", () => {
    const env = inBattle(createSeededRng(2));
    executeTool("take_action", act({ intent: "엎드려 숨을 고른다" }), env.ctx);
    expect(env.store.getState().battle?.round ?? 1).toBeGreaterThanOrEqual(1);
  });
});
