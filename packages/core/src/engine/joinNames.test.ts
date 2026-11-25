import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletEffect } from "../content/schemas.ts";
import { knowsName } from "../game/acquaintance.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { applyEffect } from "./storyletTools.ts";

/** 무리에 새로 들어도 무리 사람들의 이름을 한꺼번에 알지 않는다 (방문자가 청솔에 든 뒤 처음 본 의무실 보조 허세린이 이름으로 나왔다) */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-join-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_t_visitor", { name: "소영", gender: "female", abilities: null, portrait: null, traits: [] } as never);

describe("무리에 들 때 아는 이름", () => {
  it("상관의 이름만 알고, 처음 보는 무리 사람은 장면에 들어와도 호칭으로 나온다", () => {
    const w = make();
    const me = w.state().playerId;
    expect(knowsName(w.state(), me, "pa_narae")).toBe(false);
    // 무소속은 먼저 손님으로 들고, 대표의 면담에서 받아들일 때 든다 (공통 규칙 22 받아들임, 12-308)
    applyEffect(w.ctx(), { join_faction: { faction: "faction_a", rank: "grunt" } } as StoryletEffect, {}, {}, "테스트");
    const out = applyEffect(w.ctx(), { admission: "accept" } as StoryletEffect, {}, {}, "테스트");
    expect(w.state().characters[me]!.factionId).toBe("faction_a");
    const commander = w.state().customRole!.commander!;
    expect(knowsName(w.state(), me, commander)).toBe(true);
    expect(out.line).toContain(w.state().characters[commander]!.name);
    expect(knowsName(w.state(), me, "pa_narae")).toBe(false);
    expect(knowsName(w.state(), "pa_narae", me)).toBe(false);

    w.runCheat("~goto a_base");
    w.executeTool("npc_presence", { npc_id: "pa_narae", action: "enter" });
    const scene = w.sceneForGm();
    expect(scene).not.toContain("허세린");
    expect(scene).toContain(content.npcs.pa_narae!.alias);
  });
});
