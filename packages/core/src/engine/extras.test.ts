import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import type { Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { TEST_CONTENT } from "../testing.ts";
import { describePlayerState } from "./context.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

function setup(rng: Rng = () => 0.99) {
  const c: Content = structuredClone(TEST_CONTENT);
  for (const f of Object.values(c.factions)) f.aggression = 0;
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng, content: c };
  runAfterTimeAdvance(ctx);
  return { store, ctx, content: c };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});
const attack = (target: string, target_harm: string) =>
  act({ intent: "덮친다", target, check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", target_harm } });

describe("엑스트라", () => {
  it("틀로 캐릭터를 만들어 장면에 넣는다. 소지품은 틀이 정하고, 이름은 아직 모른다", () => {
    const env = setup();
    const out = executeTool("spawn_extra", { template: "test_sentry", label: "폭탄 든 보초" }, env.ctx);
    expect(out.ok && out.resultText).toContain("ex_1");
    const s = env.store.getState();
    const ex = s.characters.ex_1!;
    expect(ex).toMatchObject({ name: "폭탄 든 보초", factionId: "faction_c", gender: "male", inventory: { bomb: 1 }, traits: ["coward"] });
    expect(ex.inventory.rope).toBeUndefined(); // 확률 0
    expect(ex.extra).toMatchObject({ template: "test_sentry", named: false });
    expect(s.scene.present).toContain("ex_1");
    expect(s.known.player ?? []).not.toContain("ex_1");
    expect(executeTool("spawn_extra", { template: "nope", label: "x" }, env.ctx).ok).toBe(false);
    expect(describePlayerState(s, env.content)).toContain("폭탄 든 보초 (이름 모름) (ex_1)");
  });

  it("learn_name: 이름 재료로 이름을 지어 넣고, 아는 인물이 된다", () => {
    const env = setup();
    executeTool("spawn_extra", { template: "test_sentry", label: "보초" }, env.ctx);
    const out = executeTool("learn_name", { target: "ex_1" }, env.ctx);
    const name = env.store.getState().characters.ex_1!.name;
    expect(name).toMatch(/^[김이](민준|도윤)$/);
    expect(out.ok && out.resultText).toContain(name);
    expect(env.store.getState().known.player).toContain("ex_1");
    expect(executeTool("learn_name", { target: "ex_1" }, env.ctx).ok).toBe(false);
  });

  it("이름 없이 사흘 엮이지 않으면 사라지고, 이름을 얻었으면 남는다", () => {
    const env = setup();
    executeTool("spawn_extra", { template: "test_sentry", label: "보초 갑" }, env.ctx);
    executeTool("spawn_extra", { template: "test_sentry", label: "보초 을" }, env.ctx);
    executeTool("learn_name", { target: "ex_2" }, env.ctx);
    executeTool("npc_presence", { npc_id: "ex_1", action: "leave" }, env.ctx);
    executeTool("npc_presence", { npc_id: "ex_2", action: "leave" }, env.ctx);
    const s = env.store.getState();
    env.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: s.time + 3 * MINUTES_PER_DAY });
    runAfterTimeAdvance(env.ctx);
    expect(env.store.getState().characters.ex_1!.extra!.gone).toBe(true);
    expect(env.store.getState().characters.ex_2!.extra!.gone).toBe(false);
    expect(executeTool("npc_presence", { npc_id: "ex_1", action: "enter" }, env.ctx).ok).toBe(false);
    expect(executeTool("npc_presence", { npc_id: "ex_2", action: "enter" }, env.ctx).ok).toBe(true);
  });
});

describe("상대를 쓰러뜨리기", () => {
  it("성공 + heavy면 중상 → 무력화, 판정 없이 뒤질 수 있다", () => {
    const env = setup(() => 0.99); // 6+6 성공
    executeTool("spawn_extra", { template: "test_sentry", label: "보초" }, env.ctx);
    const out = executeTool("take_action", attack("ex_1", "heavy"), env.ctx);
    expect(env.store.getState().characters.ex_1!.conditions.harm).toBe("serious");
    expect(out.ok && out.resultText).toContain("무력화");
    expect(out.ok && out.resultText).toContain("폭탄(bomb) ×1");
    const take = executeTool("transfer_item", { from: "ex_1", to: "player", item_id: "bomb", quantity: 1 }, env.ctx);
    expect(take.ok).toBe(true);
    expect(env.store.getState().characters.player!.inventory.bomb).toBe(1);
  });

  it("대가 있는 성공은 1단계, 실패는 없음. 무력화 전에는 그냥 뺏을 수 없다", () => {
    const partial = setup(() => 0.5); // 4+4 = 8 → 대가 있는 성공
    executeTool("spawn_extra", { template: "test_sentry", label: "보초" }, partial.ctx);
    executeTool("take_action", attack("ex_1", "heavy"), partial.ctx);
    expect(partial.store.getState().characters.ex_1!.conditions.harm).toBe("light");
    partial.store.append({ type: "turn_started", turn: 99, input: "" }); // 다음 턴: 판정 근거 없음
    expect(executeTool("transfer_item", { from: "ex_1", to: "player", item_id: "bomb", quantity: 1 }, partial.ctx).ok).toBe(false);

    const miss = setup(() => 0); // 1+1 실패
    executeTool("spawn_extra", { template: "test_sentry", label: "보초" }, miss.ctx);
    executeTool("take_action", attack("ex_1", "heavy"), miss.ctx);
    expect(miss.store.getState().characters.ex_1!.conditions.harm).toBe("none");
  });

  it("이름 있는 인물도 다치고 죽을 수 있다 (사망은 부상 트랙으로만)", () => {
    const env = setup(() => 0.99);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
    executeTool("take_action", attack("npc_leader", "heavy"), env.ctx);
    const out = executeTool("take_action", attack("npc_leader", "heavy"), env.ctx);
    expect(env.store.getState().characters.npc_leader!.dead).toBe(true);
    expect(out.ok && out.resultText).toContain("죽었다");
    expect(env.store.getState().characters.player!.dead).toBe(false);
  });
});
