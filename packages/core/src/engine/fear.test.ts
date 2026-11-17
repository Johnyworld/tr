import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { calmAfterSleep, frighten, runFearDecay } from "./fear.ts";
import { executeTool } from "./tools.ts";
import { loadRealContent } from "../testing.ts";

/** 공포 (12-95) */
const loaded = loadRealContent();

/** 어둠 보정은 꺼 둔 월드 (따로 시험한다) */
function content(): Content {
  const c = structuredClone(loaded);
  c.scenario.body!.fear!.dark.segments = [];
  return c;
}

function setup(c = content()) {
  const roll = { value: 0.99 };
  const store = new InMemoryGameStore([createWorldEvent(c, "role_b_guard", "world_fear", () => 0.5)]);
  const ctx = { store, rng: () => roll.value, content: c };
  const me = () => store.getState().characters[store.getState().playerId]!;
  // 시작 조건을 고정한다: 냉정 0, 트레잇 없음, 동행 없음, 몸 멀쩡
  me().stats.nerve = 0;
  me().traits = [];
  store.getState().companions = [];
  return { store, ctx, roll, me, fear: () => me().conditions.fear ?? "calm" };
}

const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });

describe("공포", () => {
  it("계기의 단계만큼 오른다", () => {
    const env = setup();
    frighten(env.ctx, 1, "기습");
    expect(env.fear()).toBe("tense");
    frighten(env.ctx, 1, "또 기습");
    expect(env.fear()).toBe("scared");
  });

  it("어둠이면 한 단계 더, 동행이 있으면 한 단계 덜", () => {
    const c = content();
    c.scenario.body!.fear!.dark.segments = ["dawn", "morning", "day", "evening", "night"];
    const env = setup(c);
    frighten(env.ctx, 1, "어둠 속의 소리");
    expect(env.fear()).toBe("scared");
  });

  it("냉정으로 한 단계 버티고, 버티면 그렇다고 알린다", () => {
    const env = setup();
    env.me().stats.nerve = 3; // 45%
    env.roll.value = 0.1;
    const r = frighten(env.ctx, 1, "기습");
    expect(env.fear()).toBe("calm");
    expect(r.lines.join()).toContain("눌러 참았다");
  });

  it("겁쟁이는 더, 강철 신경은 덜 오른다", () => {
    const coward = setup();
    coward.me().traits = ["coward"];
    frighten(coward.ctx, 1, "기습");
    expect(coward.fear()).toBe("scared");
    const brave = setup();
    brave.me().traits = ["steel_nerves"];
    frighten(brave.ctx, 1, "기습");
    expect(brave.fear()).toBe("calm");
  });

  it("마주할 때마다 노출이 쌓이고, 문턱을 넘으면 덜 오른다", () => {
    const env = setup();
    for (let i = 0; i < 10; i++) env.store.append({ type: "fear_exposed", characterId: env.me().id });
    frighten(env.ctx, 2, "감염체 무리");
    expect(env.fear()).toBe("tense");
    expect(env.store.getState().fearExposure[env.me().id]).toBe(11);
  });

  it("마음이 무너져 있으면 한 단계 더", () => {
    const env = setup();
    env.me().conditions.nerves = "frayed";
    frighten(env.ctx, 1, "기습");
    expect(env.fear()).toBe("scared");
  });

  it("공황에 이르면 확률로 마음이 흔들린다", () => {
    const env = setup();
    env.roll.value = 0; // 버티지 못하고(냉정 0), 마음으로 번진다
    const r = frighten(env.ctx, 3, "떼");
    expect(env.fear()).toBe("panic");
    expect(env.me().conditions.nerves).toBe("shaken");
    expect(r.lines.join()).toContain("공황");
  });

  it("무서운 것이 없으면 시간마다 가라앉고, 자고 나면 평정", () => {
    const env = setup();
    frighten(env.ctx, 3, "떼");
    expect(env.fear()).toBe("panic");
    expect(runFearDecay(env.ctx)).toEqual([]); // 아직 시간이 안 지났다
    env.store.getState().time += 120;
    runFearDecay(env.ctx);
    expect(env.fear()).toBe("tense");
    frighten(env.ctx, 2, "다시");
    calmAfterSleep(env.ctx);
    expect(env.fear()).toBe("calm");
  });

  it("GM이 고른 fright는 이번 판정에 바로 붙고, 판정 줄에 보인다", () => {
    const env = setup();
    const out = executeTool("take_action", act({ fright: "dread", check: { move: "endure", stat: "nerve", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } }), env.ctx);
    expect(out.ok).toBe(true);
    if (!out.ok || out.display.type !== "check") return;
    expect(out.display.line).toContain("(겁먹음)");
    expect(out.resultText).toContain("두려움에 압도됐다");
  });

  it("무서운 엑스트라가 장면에 나타나면 tool 결과에 공포가 실린다", () => {
    const c = content();
    c.extras.road_dog!.fearsome = 1;
    const env = setup(c);
    const out = executeTool("spawn_extra", { template: "road_dog", label: "들개" }, env.ctx);
    expect(out.ok).toBe(true);
    expect(env.fear()).toBe("tense");
    if (out.ok) expect(out.resultText).toContain("공포");
  });

  it("감염체 지식이 있으면 감염체가 부른 공포는 한 단계 덜 오른다 (다른 공포는 그대로)", () => {
    const env = setup();
    env.me().skills.infected_lore = 1;
    frighten(env.ctx, 2, "감염체 무리", ["infected"]);
    expect(env.fear()).toBe("tense");
    frighten(env.ctx, 1, "매복");
    expect(env.fear()).toBe("scared");
  });

  it("공포증: 무서워하는 것이 나오면 한 단계 더, 보통 사람에게 무섭지 않은 장면(fright 0)에도 온다", () => {
    const plain = setup();
    frighten(plain.ctx, 0, "지하 계단", ["enclosed"]);
    expect(plain.fear()).toBe("calm");
    const phobic = setup();
    phobic.me().traits = ["claustrophobia"];
    frighten(phobic.ctx, 0, "지하 계단", ["enclosed"]);
    expect(phobic.fear()).toBe("tense");
    frighten(phobic.ctx, 1, "지하의 감염체", ["infected", "enclosed"]);
    expect(phobic.fear()).toBe("panic"); // 1 + 공포증 1
  });

  it("어둠 공포는 어둠 시간대의 모든 공포에 붙는다", () => {
    const c = content();
    c.scenario.body!.fear!.dark = { segments: ["dawn", "morning", "day", "evening", "night"], steps: 0 };
    const env = setup(c);
    env.me().traits = ["nyctophobia"];
    frighten(env.ctx, 1, "기습");
    expect(env.fear()).toBe("scared");
  });

  it("무서워하는 동물이 장면에 나타나면 (fearsome 0이어도) 공포가 실린다", () => {
    const env = setup();
    env.me().traits = ["cynophobia"];
    const out = executeTool("spawn_extra", { template: "road_dog", label: "목줄 끊긴 개" }, env.ctx);
    expect(out.ok).toBe(true);
    expect(env.fear()).toBe("tense");
  });

  it("GM이 즉흥 장면에 고른 태그로도 공포증이 걸리고, 모르는 태그는 막는다", () => {
    const env = setup();
    env.me().traits = ["aquaphobia"];
    const out = executeTool("take_action", act({ fright_tags: ["water"] }), env.ctx);
    expect(out.ok).toBe(true);
    expect(env.fear()).toBe("tense");
    const bad = executeTool("take_action", act({ fright_tags: ["spiders"] }), env.ctx);
    expect(bad.ok).toBe(false);
  });
});
