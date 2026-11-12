import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createGameSchemas } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { describeConditions } from "../scenario/scenario.ts";
import { seasonOfDay } from "../sim/season.ts";
import { initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { runCommand } from "../commands/commands.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 허기·감염 트랙, 소모품, 계절을 더한 테스트 콘텐츠 */
function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.condition_tracks.push(
    {
      id: "belly",
      label: "허기",
      levels: [
        { id: "full", label: "든든", penalty: 0 },
        { id: "peckish", label: "출출", penalty: 0 },
        { id: "weak", label: "굶주림", penalty: -1 },
      ],
    },
    {
      id: "rot",
      label: "감염",
      levels: [
        { id: "clean", label: "없음", penalty: 0 },
        { id: "latent", label: "잠복", penalty: 0, hidden: true },
        { id: "fever", label: "발열", penalty: -1 },
        { id: "grave", label: "악화", penalty: -2 },
      ],
    },
  );
  c.scenario.body = {
    hunger: { track: "belly", starving_harm: 1 },
    infection: { track: "rot", chance: { light: 1, heavy: 1 }, worst_harm: 1 },
  };
  c.scenario.consumables = { rope: { belly: 2 }, radio: { rot: 2 } };
  c.scenario.war!.ration.levels = [
    { min_days: 10, label: "정량", hunger: -2 },
    { min_days: 1, label: "반쪽 배급", hunger: 1 },
    { min_days: 0, label: "배급 끊김", hunger: 1 },
  ];
  c.scenario.seasons = {
    start: { season: "fall", day: 2 },
    list: [
      { id: "fall", label: "가을", days: 3, upkeep: {}, yields: {} },
      { id: "winter", label: "겨울", days: 2, upkeep: { food: 3 }, yields: { food: 0 } },
    ],
  };
  for (const f of Object.values(c.factions)) f.aggression = 0;
  return c;
}

function setup(c = content(), rng: Rng = () => 0.5) {
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx, content: c };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

function passDays(env: ReturnType<typeof setup>, days: number) {
  const s = env.store.getState();
  env.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + days * MINUTES_PER_DAY });
  runAfterTimeAdvance(env.ctx);
}

const level = (env: ReturnType<typeof setup>, track: string) => env.store.getState().characters.player!.conditions[track];

describe("계절", () => {
  it("1일차는 시작 계절·날짜이고, 길이만큼 돌아간다", () => {
    const s = content().scenario;
    expect(seasonOfDay(s, 1)).toMatchObject({ id: "fall", dayInSeason: 2 });
    expect(seasonOfDay(s, 3)).toMatchObject({ id: "winter", dayInSeason: 1 });
    expect(seasonOfDay(s, 5)).toMatchObject({ id: "fall", dayInSeason: 1 });
  });

  it("계절 배수가 하루 소모·산출에 들어간다", () => {
    const c = content();
    const world = initialWarWorld(c);
    const fall = simulateWarDay(world, c, () => 0.99, { season: seasonOfDay(c.scenario, 1) });
    const winter = simulateWarDay(world, c, () => 0.99, { season: seasonOfDay(c.scenario, 3) });
    expect(fall.factions.faction_a!.resources.food).toBe(400 + 10 - 20);
    expect(winter.factions.faction_a!.resources.food).toBe(400 + 0 - 60);
  });

  it("!시간과 GM 컨텍스트에 계절이 보인다", () => {
    const env = setup();
    const ctx = { state: env.store.getState(), content: env.content, summaries: [] };
    expect(runCommand("!시간", ctx)).toContain("계절  한가을 (가을 2/3일)");
    expect(describePlayerState(env.store.getState(), env.content)).toContain("계절: 한가을");
  });
});

describe("허기", () => {
  it("정량 배급이면 든든하고, 배급이 끊기면 하루마다 배가 고파지고, 바닥이면 굶주림으로 다친다", () => {
    const env = setup();
    passDays(env, 1);
    expect(level(env, "belly")).toBe("full");
    env.store.getState().factions.faction_a!.resources.food = 0;
    passDays(env, 1);
    expect(level(env, "belly")).toBe("peckish");
    env.store.getState().factions.faction_a!.resources.food = 0;
    passDays(env, 1);
    expect(level(env, "belly")).toBe("weak");
    expect(level(env, "harm")).toBe("light"); // 바닥에 이른 날부터 굶주림 피해
  });

  it("하루가 지나며 바뀐 몸 상태는 take_action 결과 문구로 GM에게 알린다", () => {
    const env = setup();
    env.store.getState().factions.faction_a!.resources.food = 0;
    executeTool("take_action", act({ activity: { kind: "wait", until: "night" } }), env.ctx);
    env.store.getState().factions.faction_a!.resources.food = 0;
    const out = executeTool("take_action", act({ activity: { kind: "sleep", until: "morning" } }), env.ctx);
    expect(out.ok && out.resultText).toContain("신병의 허기: 든든 → 출출");
  });

  it("먹을 것을 쓰면 나아진다. 배가 부르면 쓰지 않는다", () => {
    const env = setup();
    env.store.getState().characters.player!.inventory.rope = 2;
    const full = executeTool("take_action", act({ use_item: "rope" }), env.ctx);
    expect(full.ok && full.resultText).toContain("쓸 필요가 없다");
    env.store.getState().characters.player!.conditions.belly = "weak";
    executeTool("take_action", act({ use_item: "rope" }), env.ctx);
    expect(level(env, "belly")).toBe("full");
    expect(env.store.getState().characters.player!.inventory.rope).toBe(1);
  });
});

describe("감염", () => {
  const bite = { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "light", harm_cause: "감염체에게 물림", infected_source: true };

  it("감염체에게 다치면 잠복기가 된다. 잠복기는 화면·GM·명령어에 드러나지 않는다", () => {
    const env = setup(content(), () => 0);
    executeTool("take_action", act({ check: bite }), env.ctx);
    expect(level(env, "rot")).toBe("latent");
    const s = env.store.getState();
    expect(describeConditions(env.content.scenario, s.characters.player!)).toContain("감염: 없음");
    expect(describePlayerState(s, env.content)).not.toContain("잠복");
    expect(runCommand("!상태", { state: s, content: env.content, summaries: [] })).not.toContain("잠복");
  });

  it("감염체가 아닌 상처는 감염되지 않는다", () => {
    const env = setup(content(), () => 0);
    executeTool("take_action", act({ check: { ...bite, infected_source: false } }), env.ctx);
    expect(level(env, "rot")).toBe("clean");
  });

  it("하루마다 나빠지고, 악화에 이르면 하루마다 다친다. 약으로 낫는다", () => {
    const env = setup(content(), () => 0);
    executeTool("take_action", act({ check: bite }), env.ctx);
    passDays(env, 1);
    expect(level(env, "rot")).toBe("fever");
    passDays(env, 1);
    expect(level(env, "rot")).toBe("grave");
    const harmBefore = level(env, "harm");
    passDays(env, 1);
    expect(level(env, "harm")).not.toBe(harmBefore);
    env.store.getState().characters.player!.inventory.radio = 1;
    executeTool("take_action", act({ use_item: "radio" }), env.ctx);
    expect(level(env, "rot")).toBe("latent");
  });
});

describe("이전 세이브", () => {
  it("새 상태 트랙이 없던 캐릭터도 첫 단계로 읽힌다", () => {
    const c = content();
    const schemas = createGameSchemas(c.scenario);
    const old = { ...createWorldEvent(TEST_CONTENT, "role_test", "w") } as { player: { conditions: Record<string, string> } };
    expect(Object.keys(old.player.conditions)).toEqual(["harm"]);
    const parsed = schemas.event.parse(old) as { player: { conditions: Record<string, string> } };
    expect(parsed.player.conditions).toEqual({ harm: "none", belly: "full", rot: "clean" });
  });
});

/** 추위·질병 트랙을 더한 콘텐츠 */
function wintry(): Content {
  const c = content();
  c.scenario.condition_tracks.push(
    {
      id: "chill",
      label: "추위",
      levels: [
        { id: "warm", label: "따뜻함", penalty: 0 },
        { id: "cool", label: "쌀쌀함", penalty: 0 },
        { id: "cold", label: "추위", penalty: -1 },
        { id: "freezing", label: "저체온", penalty: -2 },
      ],
    },
    {
      id: "sick",
      label: "질병",
      levels: [
        { id: "well", label: "없음", penalty: 0 },
        { id: "latent", label: "잠복", penalty: 0, hidden: true },
        { id: "ill", label: "앓음", penalty: -1 },
        { id: "grave", label: "위중", penalty: -2 },
      ],
    },
  );
  c.scenario.body = {
    ...c.scenario.body,
    cold: { track: "chill", season: { winter: 1 }, weather: {}, gear: { rope: 1 }, shelter: { resource: "food", min_days: 1, warm: -2 }, worst_harm: 1 },
    disease: {
      track: "sick",
      chance: { base: 0, starving: 0, cold: 1, thirst: 0 },
      resist: { ability: "strength", per_point: 0 },
      recover: { chance: 1, per_point: 0 },
      worsen: 0,
      worst_harm: 1,
    },
  };
  c.scenario.consumables = { ...c.scenario.consumables, water_bottle: { chill: 2 } };
  return c;
}

const goOut = (env: ReturnType<typeof setup>) => {
  env.store.getState().playerZone = "wild";
};

describe("추위", () => {
  it("겨울에 거점 밖에서 하루마다 추워지고, 저체온이면 다친다", () => {
    const env = setup(wintry());
    passDays(env, 1); // 가을 2일차 → 3일차(겨울)로 넘어가는 날
    goOut(env);
    env.store.getState().characters.player!.conditions.chill = "cold";
    passDays(env, 1);
    expect(level(env, "chill")).toBe("freezing");
    expect(level(env, "harm")).toBe("light");
  });

  it("연료가 있는 우리 거점에서는 몸이 녹는다", () => {
    const env = setup(wintry());
    env.store.getState().characters.player!.conditions.chill = "freezing";
    env.store.getState().playerZone = "a_home";
    passDays(env, 1);
    expect(level(env, "chill")).toBe("cool");
  });

  it("방한 장비를 들고 있으면 추위를 덜고, 담요 같은 소모품은 쓰면 녹는다", () => {
    const env = setup(wintry());
    passDays(env, 1);
    goOut(env);
    env.store.getState().characters.player!.inventory.rope = 1;
    env.store.getState().characters.player!.conditions.chill = "cool";
    passDays(env, 1);
    expect(level(env, "chill")).toBe("warm");
    env.store.getState().characters.player!.conditions.chill = "freezing";
    env.store.getState().characters.player!.inventory.water_bottle = 1;
    executeTool("take_action", act({ use_item: "water_bottle" }), env.ctx);
    expect(level(env, "chill")).toBe("cool");
  });
});

describe("질병", () => {
  it("확률로 병에 걸린다. 잠복은 숨고, 다음 날 드러난다. 체력이 높으면 덜 걸린다", () => {
    const c = wintry();
    c.scenario.body!.disease!.chance.base = 1;
    const env = setup(c);
    passDays(env, 1);
    expect(level(env, "sick")).toBe("latent");
    passDays(env, 1);
    expect(level(env, "sick")).toBe("ill");

    const tough = wintry();
    tough.scenario.body!.disease!.chance.base = 0.5;
    tough.scenario.body!.disease!.resist.per_point = 0.5; // 근력 1 → 확률 절반 (0.25), rng 0.5면 걸리지 않는다
    const env2 = setup(tough);
    passDays(env2, 1);
    expect(level(env2, "sick")).toBe("well");
  });

  it("앓다가 배부르고 따뜻하면 낫고, 위중하면 하루마다 다친다", () => {
    const c = wintry();
    const env = setup(c);
    env.store.getState().characters.player!.conditions.sick = "ill";
    passDays(env, 1);
    expect(level(env, "sick")).toBe("well");

    const env2 = setup(wintry());
    goOut(env2);
    env2.ctx.content.scenario.body!.disease!.recover.chance = 0;
    env2.store.getState().characters.player!.conditions.sick = "grave";
    passDays(env2, 1);
    expect(level(env2, "harm")).toBe("light");
  });

  it("잠복기는 상태·명령어에 드러나지 않는다", () => {
    const env = setup(wintry());
    env.store.getState().characters.player!.conditions.sick = "latent";
    const s = env.store.getState();
    expect(runCommand("!상태", { state: s, content: env.content, summaries: [] })).not.toContain("잠복");
  });
});

describe("숨은 단계가 새지 않는다", () => {
  it("잠복기에 약을 쓰려 하면, 아무 일 없을 때와 똑같이 쓸 필요가 없다고 한다", () => {
    const env = setup();
    env.store.getState().characters.player!.inventory.radio = 1;
    const clean = executeTool("take_action", act({ use_item: "radio" }), env.ctx);
    env.store.getState().characters.player!.conditions.rot = "latent";
    const latent = executeTool("take_action", act({ use_item: "radio" }), env.ctx);
    expect(clean.ok && clean.resultText).toContain("쓸 필요가 없다");
    const first = (o: typeof clean) => (o.ok ? o.resultText.split("\n")[0] : o.error);
    expect(first(latent)).toBe(first(clean));
    expect(env.store.getState().characters.player!.inventory.radio).toBe(1);
  });
});
