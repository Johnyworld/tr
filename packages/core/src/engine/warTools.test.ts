import { describe, expect, it } from "vitest";
import { createSeededRng, type Rng } from "../rng.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { runCommand } from "../commands/commands.ts";
import { TEST_CONTENT } from "../testing.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { describePlayerState } from "./context.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { describeClash, lossWords, MAX_CATCH_UP_DAYS, WAR_TOPIC } from "./warTools.ts";

function setup(rng: Rng = createSeededRng(3)) {
  const store = new InMemoryGameStore([createWorldEvent(TEST_CONTENT, "role_test", "world_test")]);
  const ctx = { store, rng, content: TEST_CONTENT };
  runAfterTimeAdvance(ctx);
  return { store, ctx };
}

function advanceDays(env: ReturnType<typeof setup>, days: number) {
  const from = env.store.getState().time;
  env.store.append({ type: "time_advanced", activity: "wait", from, to: from + days * MINUTES_PER_DAY });
  return runAfterTimeAdvance(env.ctx);
}

describe("전쟁 틱 연결", () => {
  it("세계를 열면 세력을 시작값으로 채우고, 같은 날에는 틱이 돌지 않는다", () => {
    const env = setup();
    const state = env.store.getState();
    expect(Object.keys(state.factions).sort()).toEqual(["faction_a", "faction_c", "faction_e"]);
    expect(state.lastWarDay).toBe(1);
    runAfterTimeAdvance(env.ctx);
    expect(env.store.events().filter((e) => e.type === "war_day_simulated")).toHaveLength(0);
  });

  it("날이 바뀐 만큼 하루씩 돈다 (최대 일주일)", () => {
    const env = setup();
    advanceDays(env, 2);
    expect(env.store.events().filter((e) => e.type === "war_day_simulated").map((e) => e.day)).toEqual([2, 3]);
    advanceDays(env, 20);
    const days = env.store.events().filter((e) => e.type === "war_day_simulated").map((e) => e.day);
    expect(days.slice(2)).toHaveLength(MAX_CATCH_UP_DAYS);
    expect(days.at(-1)).toBe(23);
    expect(env.store.getState().lastWarDay).toBe(23);
  });

  it("세력이 없던 이전 세이브도 열면 채운다", () => {
    const store = new InMemoryGameStore([createWorldEvent(TEST_CONTENT, "role_test", "world_test")]);
    expect(store.getState().factions).toEqual({});
    runAfterTimeAdvance({ store, rng: createSeededRng(1), content: TEST_CONTENT });
    expect(store.getState().factions.faction_a?.population).toBe(20);
  });

  it("전쟁 설정이 없는 시나리오에서는 아무것도 하지 않는다", () => {
    const content = { ...TEST_CONTENT, scenario: { ...TEST_CONTENT.scenario, war: undefined } };
    const store = new InMemoryGameStore([createWorldEvent(content, "role_test", "world_test")]);
    runAfterTimeAdvance({ store, rng: createSeededRng(1), content });
    expect(store.getState().factions).toEqual({});
  });
});

describe("전황 소식", () => {
  it("우리 무리가 낀 교전은 보고로 듣고 화면에 보인다. 남의 일은 소문으로만", () => {
    const env = setup();
    const displays = advanceDays(env, 7);
    const clashes = env.store.events().flatMap((e) => (e.type === "war_day_simulated" ? e.clashes : []));
    const ours = clashes.filter((c) => c.attacker === "faction_a" || c.defender === "faction_a");
    expect(ours.length).toBeGreaterThan(0);
    const news = (env.store.getState().beliefs.player ?? []).filter((b) => b.topic === WAR_TOPIC);
    expect(news.filter((b) => b.source === "report")).toHaveLength(ours.length);
    expect(displays.filter((d) => d.type === "belief" && d.sourceLabel === BELIEF_SOURCE_LABELS.report)).toHaveLength(ours.length);
    for (const b of news) expect(b.accuracy).toBe("approximate");
  });

  it("소식은 시나리오의 틀로 쓰고, 사상자는 대략적인 말로만", () => {
    const text = describeClash(TEST_CONTENT, {
      kind: "assault",
      attacker: "faction_c",
      defender: "faction_a",
      zone: "a_post",
      success: true,
      attackerLosses: 1,
      defenderLosses: 4,
    });
    expect(text).toBe("세력 C가 초소를 빼앗았다. 우리 무리 사상자 몇 명.");
    expect([0, 1, 2, 3, 5, 6, 30].map(lossWords)).toEqual(["없음", "한두 명", "한두 명", "몇 명", "몇 명", "여럿", "여럿"]);
  });
});

describe("정보 필터", () => {
  it("명령어·GM 컨텍스트에 다른 무리의 진짜 자원·인원·계획, 우리 무리의 정확한 수치가 나오지 않는다", () => {
    const env = setup();
    advanceDays(env, 2);
    const state = env.store.getState();
    const ctx = { state, content: TEST_CONTENT, summaries: [] };
    const text = [runCommand("!세력", ctx), runCommand("!배급", ctx), describePlayerState(state, TEST_CONTENT)].join("\n");
    expect(text).not.toContain("비밀 공세 준비");
    expect(text).not.toContain("c_plan");
    const c = state.factions.faction_c!;
    const a = state.factions.faction_a!;
    for (const n of [c.resources.food, c.resources.bullets, c.combatants, a.resources.food, a.resources.bullets]) {
      expect(text).not.toMatch(new RegExp(`(^|\\D)${n}(\\D|$)`));
    }
  });

  it("!세력: 우리 무리 분위기·배급, 다른 무리의 공개 평판과 관계, 들은 전황", () => {
    const env = setup();
    advanceDays(env, 7);
    const out = runCommand("!세력", { state: env.store.getState(), content: TEST_CONTENT, summaries: [] });
    expect(out).toContain("소속  우리 무리 · 분위기");
    expect(out).toMatch(/세력 C {2}\[적대\] 약 60명/);
    expect(out).toMatch(/상인단 {2}\[중립\]/);
    expect(out).toContain("최근 전황");
    expect(out).toContain(`· ${BELIEF_SOURCE_LABELS.report}]`);
  });

  it("!배급: 배급 수준은 무리의 식량이 며칠 치 남았는지로 정한다", () => {
    const env = setup();
    const state = structuredClone(env.store.getState());
    const ctx = () => ({ state, content: TEST_CONTENT, summaries: [] });
    expect(runCommand("!배급", ctx())).toContain("오늘 배급  정량");
    state.factions.faction_a!.resources.food = 40; // 2일 치
    expect(runCommand("!배급", ctx())).toContain("오늘 배급  반쪽 배급");
    state.factions.faction_a!.resources.food = 0;
    expect(runCommand("!배급", ctx())).toContain("오늘 배급  배급 끊김");
  });
});
