import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { checkStorylets } from "../content/loader.ts";
import { createTestWorld, TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

const storyletSchema = createContentSchemas(TEST_SCENARIO).storylet;
const sixes: Rng = () => 0.99;

/** 스토리렛 몇 개를 넣고, 전쟁·낌새는 끈 콘텐츠 */
function content(storylets: unknown[]): Content {
  const c = structuredClone(TEST_CONTENT);
  for (const key of Object.keys(c.scenario.threats.disturbance_chance_per_hour)) {
    (c.scenario.threats.disturbance_chance_per_hour as Record<string, number>)[key] = 0;
  }
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = f.plans.map((p) => ({ ...p, days: 99 }));
  }
  c.storylets = Object.fromEntries(storylets.map((s) => storyletSchema.parse(s)).map((s) => [s.id, s]));
  return c;
}

/** 분대장이 밤에 찾아와 부탁하는 이야기 (고정) */
const favor = {
  id: "leader_favor",
  title: "분대장의 부탁",
  when: { segments: ["night"] },
  cast: { boss: { commander: true } },
  setup: "{boss:이/가} {zone}에서 조용히 부른다. {scarce}이(가) 모자란다고 한다.",
  ai_direction: "{boss}는 지쳐 있다.",
  choices: [
    {
      id: "accept",
      label: "부탁을 들어준다",
      effects: [
        { set_flag: "helped_boss" },
        { relation: { who: "boss", axis: "trust", delta: 2 } },
        { merit: 1 },
        { belief: { fact: "{boss}는 밤마다 무전기를 붙잡고 있다" } },
        { give_item: { item: "radio", from: "boss" } },
        { clock: { id: "c_plan", delta: -1 } },
        { deed: { summary: "분대장의 부탁을 들어줬다", tags: ["loyalty"], severity: 1, privacy: "semi_private" } },
      ],
    },
    {
      id: "scout",
      label: "살펴보고 정한다",
      check: "sense_danger",
      outcomes: { success: [{ set_flag: "saw_it" }], partial: [{ merit: 1 }], miss: [] },
    },
  ],
};

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

function setup(storylets: unknown[], rng: Rng = createSeededRng(4)) {
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

function toNight(env: ReturnType<typeof setup>) {
  return executeTool("take_action", act({ activity: { kind: "wait", until: "night" } }), env.ctx);
}

describe("조건과 배역", () => {
  it("시간대가 맞고 배역을 채울 수 있어야 열린다", () => {
    const env = setup([favor]);
    const s = env.store.getState();
    expect(eligibleStorylets(s, env.content)).toEqual([]); // 새벽
    const night = s.time + (20 * 60 - (s.time % MINUTES_PER_DAY));
    expect(eligibleStorylets(s, env.content, night).map((x) => x.id)).toEqual(["leader_favor"]);
    // 상관이 죽었으면 배역을 못 채운다
    s.characters.npc_leader!.dead = true;
    expect(eligibleStorylets(s, env.content, night)).toEqual([]);
  });

  it("역할 태그가 겹치지 않으면 열리지 않는다", () => {
    const env = setup([{ ...chatter, tags: ["officer_only"] }]);
    expect(eligibleStorylets(env.store.getState(), env.content)).toEqual([]);
  });
});

describe("발동", () => {
  it("기다림이 조건이 맞는 순간 끊기고, 배역이 장면에 들어오고, GM 컨텍스트에 상황·선택지가 생긴다", () => {
    const env = setup([favor]);
    const out = toNight(env);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.activeStorylet).toMatchObject({ id: "leader_favor", cast: { boss: "npc_leader" } });
    expect(s.scene.present).toContain("npc_leader");
    const ctx = describePlayerState(s, env.content);
    expect(ctx).toContain("진행 중인 이야기: 분대장의 부탁");
    expect(ctx).toContain("강분대가 우리 거점에서 조용히 부른다. 식량이(가) 모자란다고 한다.");
    expect(ctx).toContain("[GM 전용] 연출: 강분대는 지쳐 있다.");
    expect(ctx).toContain("scout 살펴보고 정한다 [먼저 take_action에서 위험 감지(sense_danger) 판정]");
    // 조건(클락 등)은 드러나지 않는다
    expect(ctx).not.toContain("c_plan");
    expect(out.ok && out.resultText).toContain("새 이야기가 시작됐다");
  });

  it("진행 중인 것이 있으면 다른 것을 열지 않고, 시간이 지나면 지나간다", () => {
    const env = setup([favor, chatter]);
    toNight(env);
    expect(env.store.getState().activeStorylet?.id).toBe("leader_favor");
    executeTool("take_action", act({ activity: { kind: "rest", until: null } }), env.ctx);
    expect(env.store.getState().activeStorylet?.id).toBe("leader_favor");
    for (let i = 0; i < 3; i++) executeTool("take_action", act({ activity: { kind: "rest", until: null } }), env.ctx);
    expect(env.store.events().some((e) => e.type === "storylet_expired")).toBe(true);
  });

  it("고정 이야기는 한 번만, 템플릿은 쿨다운이 지나면 다시 열린다", () => {
    const env = setup([chatter]);
    expect(env.store.getState().activeStorylet?.id).toBe("chatter"); // 세계를 열자마자
    executeTool("resolve_storylet", { choice_id: "listen" }, env.ctx);
    executeTool("take_action", act({ activity: { kind: "sleep", until: null } }), env.ctx);
    expect(env.store.getState().activeStorylet).toBeNull(); // 쿨다운(하루)
    for (let i = 0; i < 4 && !env.store.getState().activeStorylet; i++) {
      executeTool("take_action", act({ activity: { kind: "sleep", until: null } }), env.ctx);
    }
    expect(env.store.getState().storyletLog.chatter?.fired).toBe(2);
  });
});

describe("선택", () => {
  it("선택지 효과를 코드가 적용한다: 플래그, 관계, 공적, 믿음, 아이템, 세력 클락, 행적", () => {
    const env = setup([favor]);
    toNight(env);
    const before = env.store.getState();
    const clockBefore = before.clocks.c_plan!.filled;
    const out = executeTool("resolve_storylet", { choice_id: "accept" }, env.ctx);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.activeStorylet).toBeNull();
    expect(s.flags.player).toEqual(["helped_boss"]);
    expect(s.relations.npc_leader?.player?.trust).toBe(2);
    expect(s.perceived.npc_leader?.trust).toBe(2); // 장면에 있으니 느낀다
    expect(s.characters.player!.merit).toBe(1);
    expect(s.characters.player!.inventory.radio).toBe(1);
    expect(s.characters.npc_leader!.inventory.radio).toBeUndefined();
    expect(s.clocks.c_plan!.filled).toBe(Math.max(0, clockBefore - 1));
    expect((s.beliefs.player ?? []).some((b) => b.fact === "강분대는 밤마다 무전기를 붙잡고 있다.")).toBe(true);
    expect(Object.values(s.deeds).some((d) => d.summary === "분대장의 부탁을 들어줬다")).toBe(true);
    // 클락은 결과에 드러나지 않는다
    expect(out.ok && out.resultText).not.toContain("c_plan");
  });

  it("판정이 붙은 선택지는 이번 턴의 그 판정 결과로 갈린다. 판정이 없으면 거부한다", () => {
    const env = setup([favor], sixes);
    toNight(env);
    expect(executeTool("resolve_storylet", { choice_id: "scout" }, env.ctx).ok).toBe(false);
    executeTool(
      "take_action",
      act({ check: { move: "sense_danger", stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } }),
      env.ctx,
    );
    expect(executeTool("resolve_storylet", { choice_id: "scout" }, env.ctx).ok).toBe(true);
    expect(env.store.getState().flags.player).toEqual(["saw_it"]);
    expect(env.store.events().find((e) => e.type === "storylet_resolved")).toMatchObject({ outcome: "success" });
  });

  it("진행 중인 이야기가 없거나 없는 선택지면 거부한다", () => {
    const env = setup([favor]);
    expect(executeTool("resolve_storylet", { choice_id: "accept" }, env.ctx).ok).toBe(false);
    toNight(env);
    expect(executeTool("resolve_storylet", { choice_id: "nope" }, env.ctx).ok).toBe(false);
  });
});

describe("플래그와 정보 필터", () => {
  it("캐릭터 플래그가 secret:<flag> lore를 여는 검색자 플래그가 된다", () => {
    const world = createTestWorld();
    expect([...world.viewer().flags]).toEqual([]);
    world.ctx().store.append({ type: "flag_set", characterId: "player", flag: "scouts_captured" });
    expect([...world.viewer().flags]).toEqual(["scouts_captured"]);
  });
});

describe("조건 더하기: flags_any, day_lte, zone_owner, factions", () => {
  const base = { id: "c1", title: "조건", setup: "상황", choices: [{ id: "ok", label: "좋다", effects: [] }] };

  it("flags_any는 하나라도, day_lte는 그날까지, factions는 플레이어 소속(무소속 none)", () => {
    const env = setup([{ ...base, when: { flags_any: ["a", "b"], day_lte: 1 } }]);
    const s = env.store.getState();
    expect(eligibleStorylets(s, env.content)).toEqual([]);
    s.flags[s.playerId] = ["b"];
    expect(eligibleStorylets(s, env.content).map((x) => x.id)).toEqual(["c1"]);
    expect(eligibleStorylets(s, env.content, s.time + 2 * MINUTES_PER_DAY)).toEqual([]);
    const own = s.characters[s.playerId]!.factionId;
    const f = setup([{ ...base, when: { factions: [own] } }]);
    expect(f.store.getState().activeStorylet?.id).toBe("c1"); // 세계를 열자마자 열린다
    const none = setup([{ ...base, when: { factions: ["none"] } }]);
    expect(none.store.getState().activeStorylet).toBeNull();
  });

  it("zone_owner는 지금 구역이 우리 땅인지, 남의 땅인지, 누구의 땅도 아닌지", () => {
    const env = setup([{ ...base, when: { zone_owner: ["own"] } }]);
    expect(env.store.getState().playerZone).not.toBeNull();
    expect(env.store.getState().activeStorylet?.id).toBe("c1");
    const other = setup([{ ...base, when: { zone_owner: ["none", "other"] } }]);
    expect(other.store.getState().activeStorylet).toBeNull();
  });
});

describe("효과 더하기: npc_depart, faction_resource", () => {
  const leave = {
    id: "leave",
    title: "떠나는 사람",
    cast: { boss: { commander: true } },
    setup: "{boss:이/가} 짐을 싼다.",
    choices: [
      { id: "go", label: "보낸다", effects: [{ npc_depart: { who: "boss" } }, { faction_resource: { faction: "own", resource: "food", delta: -5 } }] },
    ],
  };

  it("떠난 NPC는 장면·배역·상관에서 빠지고, 세력 자원은 콘텐츠가 정한 만큼 바뀐다 (0 아래로 가지 않는다)", () => {
    const env = setup([leave]);
    expect(env.store.getState().activeStorylet?.id).toBe("leave");
    const own = env.store.getState().characters[env.store.getState().playerId]!.factionId;
    const food = env.store.getState().factions[own]!.resources.food ?? 0;
    const out = executeTool("resolve_storylet", { choice_id: "go" }, env.ctx);
    expect(out.ok).toBe(true);
    const s = env.store.getState();
    expect(s.characters.npc_leader).toMatchObject({ away: true, dead: false });
    expect(s.scene.present).not.toContain("npc_leader");
    expect(s.factions[own]!.resources.food).toBe(Math.max(0, food - 5));
    expect(executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx).ok).toBe(false);
    expect(describePlayerState(s, env.content)).not.toContain("수행 중인 임무 (보고는 상관에게");
  });

  it("to_faction이면 그 세력으로 넘어가고 도시에는 남는다", () => {
    const env = setup([{ ...leave, choices: [{ id: "go", label: "보낸다", effects: [{ npc_depart: { who: "boss", to_faction: "faction_b" } }] }] }]);
    executeTool("resolve_storylet", { choice_id: "go" }, env.ctx);
    expect(env.store.getState().characters.npc_leader).toMatchObject({ away: false, factionId: "faction_b" });
  });
});

describe("배역을 이름 없는 인물로 (엑스트라 틀)", () => {
  it("발동할 때 틀로 인물을 만들어 장면에 들이고, 효과의 who로 쓴다", () => {
    const env = setup([
      {
        id: "stranger",
        title: "낯선 보초",
        cast: { guard: { extra: "test_sentry", label: "길목의 보초" } },
        setup: "{guard:이/가} 길을 막는다.",
        choices: [{ id: "talk", label: "말을 건다", effects: [{ relation: { who: "guard", axis: "trust", delta: 1 } }] }],
      },
    ]);
    const s = env.store.getState();
    const id = s.activeStorylet?.cast.guard;
    expect(id).toMatch(/^ex_\d+$/);
    expect(s.characters[id!]).toMatchObject({ extra: { template: "test_sentry", label: "길목의 보초" } });
    expect(s.scene.present).toContain(id);
    expect(describePlayerState(s, env.content)).toContain("길목의 보초가 길을 막는다.");
    expect(executeTool("resolve_storylet", { choice_id: "talk" }, env.ctx).ok).toBe(true);
    expect(env.store.getState().relations[id!]?.[s.playerId]?.trust).toBe(1);
  });
});

describe("효과: 무리 사이 태도, 몸 상태 (실제 콘텐츠)", () => {
  it("faction_relation은 양쪽 태도를 바꾸고(-3~+3), body는 부상 트랙을 못 건드리고 죽음 전 단계에서 멈춘다", async () => {
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { loadContent } = await import("../content/loader.ts");
    const { disposition } = await import("../sim/war.ts");
    const real = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
    const c = structuredClone(real);
    const schema = createContentSchemas(c.scenario).storylet;
    c.storylets = {
      t: schema.parse({
        id: "t",
        title: "시험",
        setup: "상황",
        choices: [
          {
            id: "go",
            label: "한다",
            effects: [
              { faction_relation: { from: "own", to: "faction_b", delta: -2 } },
              { body: { track: "hunger", delta: 2 } },
              { body: { track: "hunger", delta: 2 } },
              { body: { track: "hunger", delta: 2 } },
              { body: { track: "harm", delta: 2 } },
            ],
          },
        ],
      }),
    };
    const store = new InMemoryGameStore([createWorldEvent(c, "role_a_grunt", "w")]);
    const ctx = { store, rng: createSeededRng(1), content: c };
    runAfterTimeAdvance(ctx);
    for (let i = 0; i < 6 && store.getState().activeStorylet?.id !== "t"; i++) {
      executeTool("take_action", act({ activity: { kind: "rest", until: null } }), ctx);
    }
    expect(store.getState().activeStorylet?.id).toBe("t");
    const before = disposition(c, "faction_a", "faction_b", store.getState());
    expect(executeTool("resolve_storylet", { choice_id: "go" }, ctx).ok).toBe(true);
    const s = store.getState();
    expect(disposition(c, "faction_a", "faction_b", s)).toBe(Math.max(-3, before - 2));
    expect(disposition(c, "faction_b", "faction_a", s)).toBe(Math.max(-3, (c.factions.faction_b!.disposition.faction_a ?? 0) - 2));
    const hunger = c.scenario.condition_tracks.find((t) => t.id === "hunger")!;
    const fatal = hunger.levels.findIndex((l) => l.fatal);
    const at = hunger.levels.findIndex((l) => l.id === s.characters.player!.conditions.hunger);
    expect(at).toBe((fatal >= 0 ? fatal : hunger.levels.length) - 1);
    expect(s.characters.player!.conditions.harm).toBe(c.scenario.condition_tracks.find((t) => t.id === "harm")!.levels[0]!.id);
    expect(s.characters.player!.dead).toBe(false);
  });
});

describe("이름 없는 인물을 이어서 부르기 (keep → recall)", () => {
  it("앞 이야기에서 keep으로 만든 인물을 다음 이야기가 recall로 다시 부른다. 없으면 열리지 않는다", () => {
    const first = {
      id: "meet",
      title: "만남",
      cast: { guard: { extra: "test_sentry", label: "길목의 보초", keep: "the_guard" } },
      setup: "{guard:이/가} 서 있다.",
      choices: [{ id: "ok", label: "본다", effects: [{ set_flag: "met_guard" }] }],
    };
    const second = {
      id: "again",
      title: "다시",
      when: { flags_all: ["met_guard"] },
      cast: { guard: { recall: "the_guard" } },
      setup: "{guard:이/가} 또 서 있다.",
      choices: [{ id: "ok", label: "본다", effects: [] }],
    };
    const env = setup([first, second]);
    const id = env.store.getState().activeStorylet?.cast.guard;
    expect(env.store.getState().keptExtras.the_guard).toBe(id);
    executeTool("resolve_storylet", { choice_id: "ok" }, env.ctx);
    const s = env.store.getState();
    expect(eligibleStorylets(s, env.content, s.time + 24 * 60).map((x) => x.id)).toContain("again");
    s.characters[id!]!.away = true;
    expect(eligibleStorylets(s, env.content, s.time + 24 * 60).map((x) => x.id)).not.toContain("again");
  });
});

describe("선택지 조건 (기획서 10.4, 12-44)", () => {
  const gate = {
    id: "gate",
    title: "문",
    cast: { boss: { commander: true } },
    setup: "{boss:이/가} 문 앞에 있다.",
    choices: [
      { id: "plain", label: "그냥 지나간다", effects: [] },
      { id: "secret", label: "아는 길로 빠진다", when: { flags_all: ["knows_path"] }, effects: [] },
      { id: "knife", label: "칼을 보인다", when: { equipped: ["kitchen_knife"] }, effects: [] },
      { id: "any", label: "물이나 무전기를 내민다", when: { has_items_any: ["water_bottle", "radio"] }, effects: [] },
      // 판정 결과 안에서 내놓는 물건도 굴리기 전에 본다
      { id: "bribe", label: "무전기를 건다", check: "persuade", outcomes: { success: [{ take_item: { item: "radio" } }], partial: [], miss: [] } },
    ],
  };

  it("조건이 맞지 않는 선택지는 GM에게 보이지 않고 고를 수도 없다", () => {
    const env = setup([gate]);
    const shown = () => describePlayerState(env.store.getState(), env.content);
    expect(shown()).toContain("plain 그냥 지나간다");
    expect(shown()).toContain("any 물이나");
    for (const hidden of ["secret", "knife", "bribe"]) expect(shown()).not.toContain(`${hidden} `);
    const no = executeTool("resolve_storylet", { choice_id: "secret" }, env.ctx);
    expect(no.ok).toBe(false);
    // 플래그가 서고, 칼을 들면 열린다
    const s = env.store.getState();
    env.store.append({ type: "flag_set", characterId: s.playerId, flag: "knows_path" });
    env.store.getState().characters[s.playerId]!.equipped = { weapon: "kitchen_knife" } as never;
    expect(shown()).toContain("secret 아는 길로");
    expect(shown()).toContain("knife 칼을 보인다");
    expect(executeTool("resolve_storylet", { choice_id: "secret" }, env.ctx).ok).toBe(true);
  });

  it("이야기 조건에도 has_items_any, equipped를 쓴다", () => {
    const env = setup([]);
    const s = env.store.getState();
    const base = storyletSchema.parse({ id: "x", title: "x", setup: "x", choices: [{ id: "a", label: "a", effects: [] }] });
    const c = { ...env.content, storylets: { x: { ...base, when: { ...base.when, has_items_any: ["radio", "water_bottle"] } } } };
    expect(eligibleStorylets(s, c).map((x) => x.id)).toEqual(["x"]);
    const c2 = { ...env.content, storylets: { x: { ...base, when: { ...base.when, equipped: ["kitchen_knife"] } } } };
    expect(eligibleStorylets(s, c2)).toEqual([]);
  });
});

describe("효과: NPC끼리, 소음, NPC 부상, 지도부 (12-44)", () => {
  const coup = {
    id: "coup",
    title: "바뀐 자리",
    cast: { boss: { commander: true, keep: "old_boss" }, other: { ids: ["npc_stranger"], enter: false } },
    setup: "{boss:이/가} 자리를 내놓는다.",
    choices: [
      {
        id: "go",
        label: "새 사람을 따른다",
        effects: [
          { npc_relation: { from: "boss", to: "other", axis: "trust", delta: -2, mutual: true } },
          { zone_noise: 2 },
          { npc_hurt: { who: "boss", steps: 2 } },
          { npc_rank: { who: "other", rank: "squad_leader" } },
          { set_commander: { who: "other" } },
        ],
      },
    ],
  };
  const again = {
    id: "again",
    title: "옛 상관",
    when: { day_gte: 1 },
    cast: { boss: { recall: "old_boss" } },
    setup: "{boss:이/가} 다시 나타난다.",
    choices: [{ id: "back", label: "되돌린다", effects: [{ set_commander: { who: "reset" } }] }],
  };

  it("NPC끼리 관계가 바뀌고, 소리가 나고, 다쳐도 죽지 않고, 상관이 바뀐다. 이름 있는 NPC도 keep → recall로 다시 부른다", () => {
    const env = setup([coup, again]);
    expect(env.store.getState().activeStorylet?.id).toBe("coup");
    // 이미 많이 다쳤어도 죽음 앞에서 멈춘다
    const before = env.store.getState();
    expect(before.keptExtras.old_boss).toBe("npc_leader");
    expect(executeTool("resolve_storylet", { choice_id: "go" }, env.ctx).ok).toBe(true);
    const s = env.store.getState();
    expect(s.relations.npc_leader?.npc_stranger?.trust).toBe(-2);
    expect(s.relations.npc_stranger?.npc_leader?.trust).toBe(-2);
    expect(s.zoneNoise[s.playerZone!]?.level).toBe(2);
    expect(s.characters.npc_leader!.dead).toBe(false);
    expect(s.characters.npc_stranger!.rank).toBe("squad_leader");
    expect(s.commanderOverride).toBe("npc_stranger");
    // 한 번 더 다쳐도 죽지 않는다
    const env2 = setup([{ ...coup, choices: [{ id: "go", label: "x", effects: Array(5).fill({ npc_hurt: { who: "boss", steps: 2 } }) }] }]);
    executeTool("resolve_storylet", { choice_id: "go" }, env2.ctx);
    expect(env2.store.getState().characters.npc_leader!.dead).toBe(false);
    // 옛 상관을 다시 불러 되돌린다
    expect(eligibleStorylets(s, env.content, s.time + 24 * 60).map((x) => x.id)).toContain("again");
  });
});

describe("있으면 쓰는 배역 (optional, 12-45)", () => {
  const maybe = {
    id: "maybe",
    title: "빈자리",
    cast: { boss: { commander: true }, ghost: { recall: "nobody_kept", optional: true } },
    setup: "{boss:이/가} 기다린다.",
    choices: [
      { id: "wait", label: "같이 기다린다", effects: [] },
      { id: "call", label: "{ghost:을/를} 부른다", when: { cast: ["ghost"] }, effects: [{ relation: { who: "ghost", axis: "trust", delta: 1 } }] },
    ],
  };
  const keeper = { id: "keeper", title: "k", when: { day_gte: 99 }, cast: { x: { extra: "test_sentry", keep: "nobody_kept" } }, setup: "x", choices: [{ id: "a", label: "a", effects: [] }] };

  it("채울 수 없어도 이야기는 열리고, 그 배역을 쓰는 선택지만 빠진다", () => {
    const env = setup([maybe, keeper]);
    const s = env.store.getState();
    expect(s.activeStorylet?.id).toBe("maybe");
    expect(s.activeStorylet?.cast.ghost).toBeUndefined();
    const ctx = describePlayerState(s, env.content);
    expect(ctx).toContain("wait 같이 기다린다");
    expect(ctx).not.toContain("call ");
    expect(executeTool("resolve_storylet", { choice_id: "call" }, env.ctx).ok).toBe(false);
  });

  it("상황에 쓰거나 when.cast 없이 쓰면 콘텐츠 검증이 잡는다", () => {
    const bad = storyletSchema.parse({ ...maybe, setup: "{ghost:이/가} 온다.", choices: [{ id: "call", label: "{ghost}", effects: [] }] });
    const c = { ...TEST_CONTENT, storylets: { maybe: bad } };
    const problems = checkStorylets(c as Content);
    expect(problems.join("\n")).toContain("상황·연출에 쓸 수 없다");
    expect(problems.join("\n")).toContain("when.cast에 적는다");
  });
});
