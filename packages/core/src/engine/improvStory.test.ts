import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { loadRealContent, TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { shouldImprovise } from "./improvStory.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 즉흥 이야기 (12-247, 기획서 10.5.5) */

const sixes: Rng = () => 0.99;
const ones: Rng = () => 0;

/** 아무 때나 반복되는 작은 이야기 (템플릿) */
const chatter = {
  id: "chatter",
  title: "잡담",
  repeatable: true,
  cooldown_days: 1,
  cast: { someone: { faction: "own", known: true, enter: false } },
  setup: "{someone:이/가} 말을 건다.",
  choices: [{ id: "listen", label: "듣는다", effects: [] }],
};

function content(storylets: unknown[]): Content {
  const c = structuredClone(TEST_CONTENT);
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = f.plans.map((p) => ({ ...p, days: 99 }));
  }
  c.scenario.condition_tracks.push({
    id: "fatigue",
    label: "피로",
    levels: [
      { id: "rested", label: "개운함", penalty: 0 },
      { id: "tired", label: "지침", penalty: 0 },
      { id: "worn", label: "녹초", penalty: -1 },
    ],
  } as (typeof c.scenario.condition_tracks)[number]);
  c.scenario.improv = {
    seen_times: 1,
    gap_hours: 20,
    item_kinds: { gear: "도구", water: "물" },
    rewards: {
      small: { items: { gear: [{ item: "rope", quantity: 1 }], water: [{ item: "water_bottle", quantity: 1 }] }, relation: 1, merit: 1 },
      medium: { items: { gear: [{ item: "radio", quantity: 1 }], water: [{ item: "water_bottle", quantity: 2 }] }, relation: 2, merit: 2 },
    },
    costs: { relation: -1, noise: 1, time: 90, body: { track: "fatigue", delta: 1 } },
  };
  const schema = createContentSchemas(c.scenario).storylet;
  c.storylets = Object.fromEntries(storylets.map((s) => schema.parse(s)).map((s) => [s.id, s]));
  return c;
}

function setup(storylets: unknown[] = [chatter], rng: Rng = createSeededRng(4)) {
  const c = content(storylets);
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx, content: c };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동",
  check: null,
  activity: null,
  deed: null,
  target: null,
  narration_summary: null,
  for_mission: false,
  ...input,
});
const check = (move: string) => act({ check: { move, stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } });

/** 처음 열린 잡담을 듣고, 다음 이야기 자리까지 시간을 보낸다 */
function toSlot(env: ReturnType<typeof setup>) {
  expect(env.store.getState().activeStorylet?.id).toBe("chatter");
  executeTool("resolve_storylet", { choice_id: "listen" }, env.ctx);
  for (let i = 0; i < 6 && !env.store.getState().improvSlot; i++) {
    executeTool("take_action", act({ activity: { kind: "sleep", until: null } }), env.ctx);
    if (!env.store.getState().improvSlot) executeTool("take_action", act({ activity: { kind: "rest", until: null } }), env.ctx);
  }
  expect(env.store.getState().improvSlot).not.toBeNull();
}

/** 장면에 상관을 들이고 즉흥 이야기를 연다 */
function improvise(env: ReturnType<typeof setup>, choices: unknown[]) {
  executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
  return executeTool("improvise_storylet", { title: "젖은 성냥", setup: "분대장이 불이 붙지 않는 성냥을 들고 있다.", cast: [{ key: "boss", character_id: "npc_leader" }], choices }, env.ctx);
}

const twoChoices = [
  { id: "dry", label: "성냥을 말려 준다", check: "sense_danger", reward: "medium", reward_kind: "item", reward_item: "gear", cost: "time" },
  { id: "walk_away", label: "모른 척한다", check: null, reward: "none", reward_kind: null, cost: "none" },
];

describe("즉흥 이야기 자리", () => {
  it("이미 본 반복 이야기가 다시 골리면 그 대신 자리를 열고, GM 상태에 보인다", () => {
    const env = setup();
    toSlot(env);
    const s = env.store.getState();
    expect(s.storyletLog.chatter?.fired).toBe(1); // 잡담을 다시 열지 않았다
    expect(s.activeStorylet).toBeNull();
    expect(describePlayerState(s, env.content)).toContain("즉흥 이야기 자리");
  });

  it("급한 이야기·위협·줄거리 이야기·처음 여는 이야기는 바꾸지 않는다", () => {
    const env = setup([
      chatter,
      { ...chatter, id: "swarm", fright: 2 },
      { ...chatter, id: "alarm", urgent: true },
      // 줄거리 몫: 플래그를 세우는 이야기, 다짐 단계 이야기
      { ...chatter, id: "secret", choices: [{ id: "listen", label: "듣는다", effects: [{ set_flag: "heard_it" }] }] },
      { ...chatter, id: "vow", when: { resolve: { stage_gte: 0 } } },
    ]);
    const s = env.store.getState();
    const c = env.content;
    const later = s.time + 60;
    s.storyletLog = { chatter: { fired: 1, lastFiredAt: s.time }, swarm: { fired: 1, lastFiredAt: s.time }, alarm: { fired: 1, lastFiredAt: s.time } };
    expect(shouldImprovise(s, c, c.storylets.chatter!, later)).toBe(true);
    expect(shouldImprovise(s, c, c.storylets.swarm!, later)).toBe(false);
    expect(shouldImprovise(s, c, c.storylets.alarm!, later)).toBe(false);
    s.storyletLog.secret = s.storyletLog.vow = { fired: 1, lastFiredAt: s.time };
    expect(shouldImprovise(s, c, c.storylets.secret!, later)).toBe(false);
    expect(shouldImprovise(s, c, c.storylets.vow!, later)).toBe(false);
    s.storyletLog = {};
    expect(shouldImprovise(s, c, c.storylets.chatter!, later)).toBe(false); // 처음이면 그대로 연다
    // 앞 자리와 gap_hours 안이면 열지 않는다
    s.storyletLog = { chatter: { fired: 1, lastFiredAt: s.time } };
    s.lastImprovSlotAt = s.time;
    expect(shouldImprovise(s, c, c.storylets.chatter!, later)).toBe(false);
  });

  it("자리는 열린 이야기와 같은 기한만큼 열려 있고(GM이 맞는 순간을 고른다), 쓰지 않으면 닫힌다 (12-290)", () => {
    const env = setup();
    toSlot(env);
    const slot = env.store.getState().improvSlot!;
    expect(slot.expiresAt - slot.openedAt).toBe(Math.round(env.content.scenario.storylet_pacing.expire_hours * 60));
    for (let i = 0; i < 8 && env.store.getState().improvSlot; i++) executeTool("take_action", act({ activity: { kind: "rest", until: null } }), env.ctx);
    expect(env.store.getState().improvSlot).toBeNull();
    expect(executeTool("improvise_storylet", { title: "t", setup: "s", cast: [], choices: twoChoices }, env.ctx).ok).toBe(false);
  });

  it("주인공이 붙잡히거나 쓰러지면 열린 자리는 닫힌다 (확인 플레이: 갇혀 의식을 잃은 주인공에게 자리가 남아 있었다)", () => {
    const env = setup();
    toSlot(env);
    env.store.getState().characters.player!.captive = { by: "faction_c", zone: "c_base", since: env.store.getState().time } as never;
    expect(describePlayerState(env.store.getState(), env.content)).not.toContain("즉흥 이야기 자리");
    expect(executeTool("improvise_storylet", { title: "t", setup: "s", cast: [], choices: twoChoices }, env.ctx).ok).toBe(false);
  });
});

describe("improvise_storylet", () => {
  it("자리가 없으면 거부한다", () => {
    const env = setup([]);
    const out = executeTool("improvise_storylet", { title: "t", setup: "s", cast: [], choices: twoChoices }, env.ctx);
    expect(out.ok).toBe(false);
  });

  it("장면에 없는 사람, 공짜 보상, 판정 없는 보통 보상, 배역 없는 관계 보상은 거부한다", () => {
    const env = setup();
    toSlot(env);
    const bad = (choices: unknown[], cast = [{ key: "boss", character_id: "npc_leader" }]) =>
      executeTool("improvise_storylet", { title: "t", setup: "s", cast, choices }, env.ctx);
    expect(bad(twoChoices, [{ key: "x", character_id: "npc_medic" }]).ok).toBe(false);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
    expect(bad([twoChoices[1], { id: "take", label: "받는다", check: null, reward: "small", reward_kind: "item", cost: "none" }]).ok).toBe(false);
    expect(bad([twoChoices[1], { id: "take", label: "받는다", check: null, reward: "medium", reward_kind: "item", cost: "time" }]).ok).toBe(false);
    expect(bad([twoChoices[1], { id: "warm", label: "달랜다", check: "persuade", reward: "small", reward_kind: "relation", reward_who: "nobody", cost: "none" }]).ok).toBe(false);
    expect(env.store.getState().activeStorylet).toBeNull();
    expect(env.store.getState().improvSlot).not.toBeNull(); // 실패한 시도는 자리를 쓰지 않는다
  });

  it("지은 이야기가 진행 중인 이야기가 되고, 선택지는 보이지만 보상은 보이지 않는다", () => {
    const env = setup();
    toSlot(env);
    const out = improvise(env, twoChoices);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.improvSlot).toBeNull();
    expect(s.activeStorylet).toMatchObject({ cast: { boss: "npc_leader" } });
    expect(s.activeStorylet!.improvised).toBeDefined();
    expect(out.ok && out.resultText).toContain('즉흥 이야기 "젖은 성냥"을 열었다');
    const ctx = describePlayerState(s, env.content);
    expect(ctx).toContain("진행 중인 이야기: 젖은 성냥");
    expect(ctx).toContain("dry 성냥을 말려 준다");
    // 보상(무전기 등)은 선택지 줄에 보이지 않는다
    expect(ctx).not.toMatch(/선택지 \(resolve_storylet\)[^\n]*(radio|무전기|medium)/);
  });

  it("물건 보상은 갈래가 있어야 하고, 고른 갈래의 물건이 나온다", () => {
    const env = setup([chatter], sixes);
    toSlot(env);
    const noKind = improvise(env, [{ ...twoChoices[0], reward_item: null }, twoChoices[1]]);
    expect(noKind.ok).toBe(false);
    expect(improvise(env, [{ ...twoChoices[0], reward_item: "jewels" }, twoChoices[1]]).ok).toBe(false);
    expect(improvise(env, [{ ...twoChoices[0], reward_item: "water" }, twoChoices[1]]).ok).toBe(true);
    executeTool("take_action", check("sense_danger"), env.ctx);
    const before = env.store.getState().characters.player!.inventory.water_bottle ?? 0;
    executeTool("resolve_storylet", { choice_id: "dry" }, env.ctx);
    expect(env.store.getState().characters.player!.inventory.water_bottle).toBe(before + 2);
    expect(env.store.getState().characters.player!.inventory.radio).toBeUndefined();
  });

  it("판정 성공이면 보상 등급의 물건을 받는다", () => {
    const env = setup([chatter], sixes);
    toSlot(env);
    improvise(env, twoChoices);
    executeTool("take_action", check("sense_danger"), env.ctx);
    const out = executeTool("resolve_storylet", { choice_id: "dry" }, env.ctx);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.characters.player!.inventory.radio).toBe(1); // medium 목록
    expect(s.activeStorylet).toBeNull();
  });

  it("판정 실패면 대가만 치른다 (시간)", () => {
    const env = setup([chatter], ones);
    toSlot(env);
    improvise(env, twoChoices);
    executeTool("take_action", check("sense_danger"), env.ctx);
    const before = env.store.getState().time;
    expect(executeTool("resolve_storylet", { choice_id: "dry" }, env.ctx).ok).toBe(true);
    const s = env.store.getState();
    expect(s.characters.player!.inventory.radio).toBeUndefined();
    expect(s.time).toBe(before + 90);
  });

  it("판정 없는 선택지는 작은 보상과 대가를 함께 받는다 (관계·몸)", () => {
    const env = setup();
    toSlot(env);
    improvise(env, [
      { id: "share", label: "같이 불을 피운다", check: null, reward: "small", reward_kind: "relation", reward_who: "boss", reward_axis: "affection", cost: "body" },
      twoChoices[1],
    ]);
    const before = env.store.getState().relations.npc_leader?.player?.affection ?? 0;
    expect(executeTool("resolve_storylet", { choice_id: "share" }, env.ctx).ok).toBe(true);
    const s = env.store.getState();
    expect(s.relations.npc_leader?.player?.affection).toBe(before + 1);
    expect(s.characters.player!.conditions.fatigue).toBe("tired");
  });
});

describe("물건 내주기 (give)", () => {
  it("가진 물건을 내주고 보상을 받는다 (맞바꾸기). 없는 물건은 고를 수 없다", () => {
    const env = setup();
    toSlot(env);
    const swap = { id: "swap", label: "물병을 내주고 밧줄을 받는다", check: null, reward: "small", reward_kind: "item", reward_item: "gear", cost: "give", cost_item: "water_bottle" };
    expect(improvise(env, [{ ...swap, cost_item: "bomb" }, twoChoices[1]]).ok).toBe(false); // 가지지 않은 것
    env.store.getState().characters.player!.inventory.water_bottle = 1;
    expect(improvise(env, [swap, twoChoices[1]]).ok).toBe(true);
    const out = executeTool("resolve_storylet", { choice_id: "swap" }, env.ctx);
    expect(out.ok && out.resultText).toContain("물병 ×1을 내주었다");
    const p = env.store.getState().characters.player!;
    expect(p.inventory.water_bottle ?? 0).toBe(0);
    expect(p.inventory.rope).toBe(1);
  });
});

describe("실제 월드 팩", () => {
  it("post_apoc의 improv 설정: 몸 대가는 부상이 아니고, 보상 물건은 다 있다", () => {
    const real = loadRealContent();
    const rule = real.scenario.improv!;
    expect(rule.costs.body.track).not.toBe(real.scenario.harm_track);
    for (const tier of ["small", "medium"] as const) for (const { item } of Object.values(rule.rewards[tier].items).flat()) expect(real.items[item]).toBeDefined();
  });
});
