import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { runFavorsDaily } from "./favors.ts";
import { runBrokenPromises } from "./promises.ts";
import { runCommand } from "../commands/commands.ts";
import { buildPlayerView } from "../views/player.ts";

/** 부탁 (12-174) */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0.1) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-favor-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;

/** 윤채원을 만나게 하고 부탁을 품게 한다 */
function offered() {
  const w = make();
  expect(w.executeTool("npc_presence", { npc_id: "a_chaewon", action: "enter" }).ok).toBe(true);
  // 같은 분대는 처음부터 아는 사이라 후보가 여럿이다. 윤채원이 뽑힐 때까지 다른 부탁은 접는다
  for (let i = 0; i < 40 && !w.state().favors.some((f) => f.npc === "a_chaewon"); i++) {
    for (const f of w.state().favors.filter((x) => x.status === "offered")) w.ctx().store.append({ type: "favor_settled", id: f.id, status: "lapsed" });
    runFavorsDaily(w.ctx());
  }
  const f = w.state().favors.find((x) => x.npc === "a_chaewon")!;
  expect(f).toBeTruthy();
  return { w, f };
}

describe("부탁", () => {
  it("만난 인물이 부탁을 품고, 인물 카드에 보인다", () => {
    const { w, f } = offered();
    expect(f.status).toBe("offered");
    expect(w.sceneForGm()).toContain(`이 인물이 꺼낼 부탁 ${f.id}`);
  });

  it("받으면 물건 약속이 되고, 지키면 물건이 건너가고 보답을 받는다", () => {
    const { w, f } = offered();
    const r = w.executeTool("favor", { favor_id: f.id, action: "accept" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const p = w.state().promises.find((x) => x.favor === f.id)!;
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
    expect(w.state().favors.find((x) => x.id === f.id)?.status).toBe("kept");
  });

  it("약속한 물건을 transfer_item으로 건네도 지킨 것이다 (플레이 테스트 4)", () => {
    const { w, f } = offered();
    w.executeTool("favor", { favor_id: f.id, action: "accept" });
    const p = w.state().promises.find((x) => x.favor === f.id)!;
    expect(w.runCheat("~give antibiotics 1").ok).toBe(true);
    const r = w.executeTool("transfer_item", { from: w.state().playerId, to: "a_chaewon", item_id: "antibiotics", quantity: 1 });
    expect(r.ok && r.resultText).toContain("약속을 지켰다");
    expect(r.ok && r.resultText).toContain("고맙다며");
    expect(w.state().promises.find((x) => x.id === p.id)?.status).toBe("kept");
    expect(w.state().favors.find((x) => x.id === f.id)?.status).toBe("kept");
  });

  it("거절하면 접히고, 같은 부탁은 다시 오지 않는다", () => {
    const { w, f } = offered();
    expect(w.executeTool("favor", { favor_id: f.id, action: "decline" }).ok).toBe(true);
    expect(w.state().favors.find((x) => x.id === f.id)?.status).toBe("declined");
    for (let i = 0; i < 30; i++) runFavorsDaily(w.ctx());
    expect(w.state().favors.filter((x) => x.npc === "a_chaewon")).toHaveLength(1);
  });

  it("받고 기한을 넘기면 어긴 부탁이 된다", () => {
    const { w, f } = offered();
    w.executeTool("favor", { favor_id: f.id, action: "accept" });
    expect(w.runCheat("~time +6d").ok).toBe(true);
    runBrokenPromises(w.ctx());
    expect(w.state().favors.find((x) => x.id === f.id)?.status).toBe("broken");
  });
});
