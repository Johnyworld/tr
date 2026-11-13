import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import type { Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describeZonePeople } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

const ones: Rng = () => 0;

function content(): Content {
  const c = structuredClone(TEST_CONTENT);
  c.scenario.recovery = { natural_days: 2, natural_max_level: "serious", healer: { harm: 1 } };
  c.scenario.consumables = { radio: { harm: 1 }, bomb: { harm: 2 } };
  c.npcs.npc_leader!.healer = true;
  for (const f of Object.values(c.factions)) f.aggression = 0;
  return c;
}

function setup(rng: Rng = ones) {
  const c = content();
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

/** 실패 + heavy → 2단계 (무사 → 중상) */
function wound(env: ReturnType<typeof setup>) {
  executeTool("take_action", act({ check: { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "heavy", harm_cause: "총상" } }), env.ctx);
  expect(env.store.getState().characters.player!.conditions.harm).toBe("serious");
}

const harm = (env: ReturnType<typeof setup>) => env.store.getState().characters.player!.conditions.harm;

describe("치료", () => {
  it("아이템을 쓰면 정해진 단계만큼 낫고 아이템을 쓴다", () => {
    const env = setup();
    wound(env);
    env.store.getState().characters.player!.inventory.bomb = 1;
    const out = executeTool("take_action", act({ use_item: "bomb" }), env.ctx);
    expect(out.ok).toBe(true);
    expect(harm(env)).toBe("none");
    expect(env.store.getState().characters.player!.inventory.bomb).toBeUndefined();
    expect(out.ok && [out.display, ...(out.extra ?? [])].some((d) => d.type === "heal")).toBe(true);
  });

  it("치료사가 장면에 있으면 하루 한 번 받는다", () => {
    const env = setup();
    wound(env);
    expect(executeTool("take_action", act({ treatment: { item: null } }), env.ctx).ok).toBe(true);
    expect(harm(env)).toBe("serious"); // 치료사가 없다
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
    executeTool("take_action", act({ treatment: { item: null } }), env.ctx);
    expect(harm(env)).toBe("light");
    const again = executeTool("take_action", act({ treatment: { item: null } }), env.ctx);
    expect(again.ok && again.resultText).toContain("오늘은 이미 치료를 받았다");
    expect(harm(env)).toBe("light");
  });

  it("다친 데가 없거나 치료에 못 쓰는 아이템이면 낫지 않는다", () => {
    const env = setup();
    env.store.getState().characters.player!.inventory.radio = 1;
    const out = executeTool("take_action", act({ use_item: "radio" }), env.ctx);
    expect(out.ok && out.resultText).toContain("쓸 필요가 없다");
  });
});

describe("저절로 낫기", () => {
  it("새 부상 없이 이틀이 지나면 한 단계씩 낫는다. 치명상은 저절로 낫지 않는다", () => {
    const env = setup();
    wound(env);
    const pass = (days: number) => {
      const s = env.store.getState();
      env.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + days * MINUTES_PER_DAY });
      runAfterTimeAdvance(env.ctx);
    };
    pass(1);
    expect(harm(env)).toBe("serious");
    pass(1);
    expect(harm(env)).toBe("light");
    pass(2);
    expect(harm(env)).toBe("none");

    const env2 = setup();
    wound(env2);
    wound2(env2);
    expect(env2.store.getState().characters.player!.conditions.harm).toBe("critical");
    const s = env2.store.getState();
    env2.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + 6 * MINUTES_PER_DAY });
    runAfterTimeAdvance(env2.ctx);
    expect(env2.store.getState().characters.player!.conditions.harm).toBe("critical");
  });
});

/** 중상 → 치명상 (대가 있는 성공 1단계가 아니라 실패 heavy 2단계면 사망이므로 light로) */
function wound2(env: ReturnType<typeof setup>) {
  executeTool("take_action", act({ check: { move: "fight", stat: "strength", difficulty: "hard", harm_on_failure: "light", harm_cause: "파편" } }), env.ctx);
}

describe("구역에서 마주칠 수 있는 사람", () => {
  it("그 구역이 집인 모르는 인물은 이름 없이 겉모습만 보인다", () => {
    const c = content();
    c.npcs.npc_stranger!.zone = "a_home";
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
    runAfterTimeAdvance({ store, rng: ones, content: c });
    const text = describeZonePeople(store.getState(), c);
    expect(text).toContain("(npc_stranger) 망토 두른 상인: 망토를 두른 상인");
    expect(text).not.toContain("낯선이");
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, { store, rng: ones, content: c });
    executeTool("npc_presence", { npc_id: "npc_stranger", action: "leave" }, { store, rng: ones, content: c });
    expect(describeZonePeople(store.getState(), c)).toBe(""); // 이제 아는 인물
  });
});
