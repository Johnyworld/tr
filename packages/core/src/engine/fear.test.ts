import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { calmAfterSleep, FEAR_SAME_MOMENT, frighten as frightenNow, runFearDecay } from "./fear.ts";
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

/** 계기마다 다른 순간으로 (같은 순간에는 공포가 한 번만 오른다, 12-241) */
function frighten(ctx: Parameters<typeof frightenNow>[0], ...rest: [number, string, (readonly string[])?]) {
  const t = ctx.store.getState().time;
  ctx.store.append({ type: "time_advanced", activity: "wait", from: t, to: t + FEAR_SAME_MOMENT + 1 });
  return frightenNow(ctx, ...rest);
}

function setup(c = content()) {
  // 마음 다잡기 (12-220): 0.01이면 주사위 1+1이라 다잡지 못한다
  const roll = { value: 0.01 };
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

  it("마음 다잡기를 굴려 성공하면 오르지 않고, 대가 있는 성공이면 한 단계 덜 (적어도 한 단계)", () => {
    const env = setup();
    env.roll.value = 0.99; // 6+6
    const r = frighten(env.ctx, 2, "기습");
    expect(env.fear()).toBe("calm");
    expect(r.lines.join()).toContain("눌러 참았다");
    expect(r.displays.some((d) => d.type === "check" && d.line?.includes("버티기"))).toBe(true);
    env.roll.value = 0.5; // 4+4 = 8 → 대가 있는 성공
    frighten(env.ctx, 2, "감염체 무리");
    expect(env.fear()).toBe("tense");
    frighten(env.ctx, 1, "또 기습");
    expect(env.fear()).toBe("scared");
  });

  it("다잡지 못하고 공황에 이르면 마음도 한 단계 오른다 (굴리지 않는다)", () => {
    const env = setup();
    env.me().conditions.fear = "scared";
    const r = frighten(env.ctx, 1, "기습");
    expect(env.fear()).toBe("panic");
    expect(env.me().conditions.nerves).toBe("shaken");
    expect(r.displays.filter((d) => d.type === "check")).toHaveLength(1);
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

  it("여러 번 겪어도 덜 무서워지지 않는다 (둔감해짐은 12-185에 뺐다)", () => {
    const env = setup();
    for (let i = 0; i < 30; i++) env.store.append({ type: "fear_exposed", characterId: env.me().id });
    frighten(env.ctx, 2, "감염체 무리");
    expect(env.fear()).toBe("scared");
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
    frighten(env.ctx, 1, "발소리"); // 계기 하나로는 두 단계까지 (D7): 먼저 긴장
    const r = frighten(env.ctx, 3, "떼");
    expect(env.fear()).toBe("panic");
    expect(env.me().conditions.nerves).toBe("shaken");
    expect(r.lines.join()).toContain("공황");
  });

  it("무서운 것이 없으면 시간마다 가라앉고, 자고 나면 평정", () => {
    const env = setup();
    frighten(env.ctx, 1, "발소리");
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

  it("계기 하나로 오르는 공포는 두 단계까지 (D7: 평온에서 한 번에 공황은 없다)", () => {
    const env = setup();
    frighten(env.ctx, 3, "떼");
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
    frighten(phobic.ctx, 1, "지하의 감염체", ["enclosed"]);
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
