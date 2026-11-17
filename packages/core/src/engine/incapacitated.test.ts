import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRng } from "../rng.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { WorldManager } from "../world/manager.ts";
import { loadRealContent } from "../testing.ts";

/** 의식불명: 스스로 아무것도 하지 못한다 (증상의 incapacitates) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });

describe("의식불명", () => {
  it("판정·이동·이야기·대화가 막히고, 시간 흐르기만 된다. GM 장면에 그렇게 알린다. 정해진 시간이 지나면 정신이 든다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-ko-")), content, rngFactory: () => createSeededRng(4) });
    const w = m.create("mcp", "role_b_guard", choice);
    w.runCheat("~time +8h");
    expect(w.runCheat("~harm me unconscious").ok).toBe(true);
    // 이야기가 열리지 않는다
    expect(eligibleStorylets(w.state(), w.content)).toEqual([]);
    // 판정·이동은 안 된다
    const check = { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "" };
    const r1 = w.executeTool("take_action", act("일어나 싸운다", { check }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("의식불명");
    expect(w.executeTool("take_action", act("간다", { move_to: "old_town" })).ok).toBe(false);
    expect(w.executeTool("take_action", act("뒤진다", { activity: { kind: "search", until: null } })).ok).toBe(false);
    // 플레이어의 행동이 되는 다른 tool도 막힌다
    const r2 = w.executeTool("resolve_storylet", { choice_id: "x" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("의식불명");
    // GM 장면에 알린다
    expect(w.sceneForGm()).toContain("스스로 아무것도 하지 못한다");
    // 시간은 흐른다. 6시간이 지나면 정신이 든다 (의식장애)
    const wait = w.executeTool("take_action", act("의식이 없다", { activity: { kind: "wait", until: null } }));
    expect(wait.ok, wait.ok ? "" : wait.error).toBe(true);
    for (let i = 0; i < 3 && w.state().characters.player!.conditions.harm === "unconscious"; i++) {
      expect(w.executeTool("take_action", act("의식이 없다", { activity: { kind: "sleep", until: "morning" } })).ok).toBe(true);
    }
    expect(w.state().characters.player!.conditions.harm).toBe("impaired");
    // 깨어나면 다시 행동할 수 있다
    expect(w.executeTool("take_action", act("몸을 일으킨다", { check })).ok).toBe(true);
    w.close();
  });
});
