import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { runCommand } from "../commands/commands.ts";

/** 약속 (12-160) */
const content = { ...loadRealContent(), storylets: {} };
const make = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-promise-")), content, rngFactory: () => () => 0.99 }).create("mcp", "role_a_grunt");
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const rel = (w: GameWorld, id: string) => w.state().relations[id]?.[me(w).id] ?? NEUTRAL_RELATION;
const promise = (w: GameWorld, input: Record<string, unknown>) => w.executeTool("promise", input);
const NPC = "a_chaewon";

function setup() {
  const w = make();
  expect(w.runCheat(`~summon ${NPC}`).ok).toBe(true);
  return w;
}

describe("약속", () => {
  it("물건 약속을 지키면 물건이 건너가고 믿음이 오른다", () => {
    const w = setup();
    const r = promise(w, { action: "make", npc_id: NPC, what: "구급상자를 구해 주겠다", days: 3, item: { id: "medkit", quantity: 1 } });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.sceneForGm()).toContain("약속 p_1");
    expect(runCommand("?임무", { state: w.state(), content, summaries: [] })).toContain("지킬 약속");
    const id = "p_1";
    expect(promise(w, { action: "keep", promise_id: id }).ok).toBe(false); // 물건이 없다
    expect(w.runCheat("~give medkit").ok).toBe(true);
    const before = rel(w, NPC).trust;
    const kept = promise(w, { action: "keep", promise_id: id });
    expect(kept.ok, kept.ok ? "" : kept.error).toBe(true);
    expect(w.state().characters[NPC]!.inventory.medkit).toBeGreaterThanOrEqual(1);
    expect(rel(w, NPC).trust).toBeGreaterThan(before);
    expect(w.state().promises[0]!.status).toBe("kept");
  });

  it("기한을 넘기면 어긴 것이 되고 그 사람이 기억한다", () => {
    const w = setup();
    expect(promise(w, { action: "make", npc_id: NPC, what: "내일 물을 길어 오겠다", days: 1 }).ok).toBe(true);
    const before = rel(w, NPC).trust;
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(w.state().promises[0]!.status).toBe("open"); // 기한 날까지는 열려 있다
    expect(w.runCheat("~time +1d").ok).toBe(true);
    expect(w.state().promises[0]!.status).toBe("broken");
    expect(rel(w, NPC).trust).toBeLessThan(before);
    const deeds = Object.values(w.state().deeds).filter((d) => d.summary.includes("약속을 어겼다"));
    expect(deeds).toHaveLength(1);
  });

  it("접으면 조금만 깎인다", () => {
    const w = setup();
    expect(promise(w, { action: "make", npc_id: NPC, what: "같이 가 주겠다", days: 2 }).ok).toBe(true);
    const before = rel(w, NPC).trust;
    expect(promise(w, { action: "fold", promise_id: "p_1" }).ok).toBe(true);
    expect(rel(w, NPC).trust).toBe(before - 1);
    expect(w.state().promises[0]!.status).toBe("folded");
  });
});
