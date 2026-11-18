import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { runAsksDaily, runBrokenPromises } from "./promises.ts";
import { runCommand } from "../commands/commands.ts";
import { buildPlayerView } from "../views/player.ts";

/** 부탁 (12-174): 12-181부터 약속의 한 갈래 (인물이 꺼내고 promise accept·decline으로 답한다) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0.1) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-favor-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const asks = (w: GameWorld) => w.state().promises.filter((p) => p.favor);
const status = (w: GameWorld, id: string) => w.state().promises.find((x) => x.id === id)?.status;

/** 윤채원을 만나게 하고 부탁을 품게 한다 */
function offered() {
  const w = make();
  expect(w.executeTool("npc_presence", { npc_id: "a_chaewon", action: "enter" }).ok).toBe(true);
  // 같은 분대는 처음부터 아는 사이라 후보가 여럿이다. 윤채원이 뽑힐 때까지 다른 부탁은 접는다
  for (let i = 0; i < 40 && !asks(w).some((f) => f.to === "a_chaewon"); i++) {
    for (const f of asks(w).filter((x) => x.status === "asked")) w.ctx().store.append({ type: "promise_settled", id: f.id, status: "lapsed" });
    runAsksDaily(w.ctx());
  }
  const f = asks(w).find((x) => x.to === "a_chaewon")!;
  expect(f).toBeTruthy();
  return { w, f };
}

describe("부탁", () => {
  it("만난 인물이 부탁을 품고, 인물 카드에 보인다", () => {
    const { w, f } = offered();
    expect(f.status).toBe("asked");
    expect(w.sceneForGm()).toContain(`이 인물이 꺼낼 부탁 ${f.id}`);
  });

  it("받으면 물건 약속이 되고, 지키면 물건이 건너가고 보답을 받는다", () => {
    const { w, f } = offered();
    const r = w.executeTool("promise", { action: "accept", promise_id: f.id });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const p = w.state().promises.find((x) => x.id === f.id)!;
    expect(p.item).toEqual({ id: "antibiotics", quantity: 1 });
    // ?임무·인물 카드·상태 화면에는 '부탁'으로 보인다
    expect(w.sceneForGm()).toContain(`이 인물의 부탁 ${p.id} (들어주기로 했다)`);
    expect(runCommand("?임무", { state: w.state(), content, summaries: [] })).toContain(`의 부탁 ${p.id}`);
    expect(buildPlayerView(w.state(), content).todos.filter((t) => t.kind === "부탁")).toMatchObject([{ key: p.id, who: "윤채원" }]);
    expect(w.runCheat("~give antibiotics 1").ok).toBe(true);
    const pain = me(w).inventory.painkiller ?? 0;
    const k = w.executeTool("promise", { action: "keep", promise_id: p.id });
    expect(k.ok, k.ok ? "" : k.error).toBe(true);
    expect(k.ok && k.resultText).toContain("고맙다며");
    expect(me(w).inventory.painkiller).toBe(pain + 1);
    expect(w.state().characters.a_chaewon!.inventory.antibiotics).toBeGreaterThanOrEqual(1);
    expect(status(w, f.id)).toBe("kept");
  });

  it("약속한 물건을 transfer_item으로 건네도 지킨 것이다 (플레이 테스트 4)", () => {
    const { w, f } = offered();
    w.executeTool("promise", { action: "accept", promise_id: f.id });
    const p = w.state().promises.find((x) => x.id === f.id)!;
    expect(w.runCheat("~give antibiotics 1").ok).toBe(true);
    const r = w.executeTool("transfer_item", { from: w.state().playerId, to: "a_chaewon", item_id: "antibiotics", quantity: 1 });
    expect(r.ok && r.resultText).toContain("약속을 지켰다");
    expect(r.ok && r.resultText).toContain("고맙다며");
    expect(w.state().promises.find((x) => x.id === p.id)?.status).toBe("kept");
    expect(status(w, f.id)).toBe("kept");
  });

  it("거절하면 접히고, 같은 부탁은 다시 오지 않는다", () => {
    const { w, f } = offered();
    expect(w.executeTool("promise", { action: "decline", promise_id: f.id }).ok).toBe(true);
    expect(status(w, f.id)).toBe("declined");
    for (let i = 0; i < 30; i++) runAsksDaily(w.ctx());
    expect(asks(w).filter((x) => x.to === "a_chaewon")).toHaveLength(1);
  });

  it("받고 기한을 넘기면 어긴 부탁이 된다", () => {
    const { w, f } = offered();
    w.executeTool("promise", { action: "accept", promise_id: f.id });
    expect(w.runCheat("~time +6d").ok).toBe(true);
    runBrokenPromises(w.ctx());
    expect(status(w, f.id)).toBe("broken");
  });
});

describe("예전 부탁 이벤트 (세이브 71까지)", () => {
  it("꺼낸 부탁·받은 부탁이 약속 목록 하나로 옮겨진다", () => {
    const w = make(0.99);
    const s = w.ctx().store;
    s.append({ type: "favor_offered", id: "f_1", npc: "a_chaewon", favor: "chaewon_antibiotics" });
    s.append({ type: "favor_offered", id: "f_2", npc: "a_taeho", favor: "x" });
    s.append({ type: "favor_settled", id: "f_1", status: "accepted" });
    s.append({ type: "promise_made", id: "p_1", by: w.state().playerId, to: "a_chaewon", what: "항생제", due: 9, item: { id: "antibiotics", quantity: 1 }, favor: "f_1" });
    s.append({ type: "favor_settled", id: "f_2", status: "declined" });
    expect(w.state().promises.map((p) => [p.id, p.status, p.favor])).toEqual([
      ["f_2", "declined", "x"],
      ["p_1", "open", "chaewon_antibiotics"],
    ]);
  });
});
