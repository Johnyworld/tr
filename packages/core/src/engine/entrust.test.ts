import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";
import { describePlayerState } from "./context.ts";

/** 맡긴 물건 (12-196) */
const content = { ...loadRealContent(), storylets: {} };

describe("맡긴 물건", () => {
  it("맡기면 기록되고, 맡은 사람에게서 근거 없이 돌려받으면 기록이 지워진다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-entrust-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_t_visitor");
    const me = w.state().playerId;
    const item = Object.keys(w.state().characters[me]!.inventory)[0]!;
    const npc = Object.keys(content.npcs).find((id) => w.state().characters[id] && !w.state().characters[id]!.dead)!;
    expect(w.runCheat(`~summon ${npc}`).ok).toBe(true);
    const r = w.executeTool("transfer_item", { from: me, to: npc, item_id: item, quantity: 1, deposit: "나갈 때 돌려준다" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().entrusted).toEqual([expect.objectContaining({ owner: me, holder: npc, itemId: item, note: "나갈 때 돌려준다" })]);
    expect(describePlayerState(w.state(), content)).toContain("맡긴 물건");
    const back = w.executeTool("transfer_item", { from: npc, to: me, item_id: item, quantity: 1 });
    expect(back.ok, back.ok ? "" : back.error).toBe(true);
    expect(w.state().entrusted).toEqual([]);
  });
});
