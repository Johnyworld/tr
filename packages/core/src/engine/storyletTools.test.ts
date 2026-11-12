import { describe, expect, it } from "vitest";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { eligibleStorylets } from "../story/storylets.ts";
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
