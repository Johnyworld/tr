import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldOf } from "../rules/held.ts";
import { whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { hostileZone } from "./storyletTools.ts";

/** 적 거점에서 들킴, 회복 간격 (12-266, 사용자 결정). 실제 경로로 본다 */
const content = loadRealContent();
const make = (roleId: string, roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-266-")), content, rngFactory: () => () => roll }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
type W = ReturnType<typeof make>;
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const alarmOpen = (w: W) => !!w.state().activeStorylet && (content.storylets[w.state().activeStorylet!.id]?.tags ?? []).includes(content.scenario.alarm!.tag);

describe("적 거점에서 들키면 경보 (12-266)", () => {
  const atEnemyBase = () => {
    const w = make("role_a_grunt");
    w.runCheat("~goto c_warehouse");
    expect(hostileZone(w.state(), content)).toBe(true);
    if (w.state().activeStorylet) w.ctx().store.append({ type: "storylet_expired", storyletId: w.state().activeStorylet!.id });
    return w;
  };

  it("그 땅 주인 무리 사람을 치면 경보 이야기가 열린다", () => {
    const w = atEnemyBase();
    const foe = Object.values(content.npcs).find((n) => n.faction === "faction_c" && whereIs(w.state(), content, n.id)?.zone === "c_warehouse" && !heldOf(w.state().characters[n.id]))!.id;
    w.executeTool("npc_presence", { npc_id: foe, action: "enter" });
    const r = w.executeTool("take_action", act({ target: foe, check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(alarmOpen(w)).toBe(true);
    expect(r.ok && r.resultText).toContain("경보가 울린다");
  });

  it("아무도 못 본 일에는 경보가 없다", () => {
    const w = atEnemyBase();
    for (const id of [...w.state().scene.present]) w.executeTool("npc_presence", { npc_id: id, action: "leave" });
    const r = w.executeTool("take_action", act({ deed: { summary: "빈 창고에서 통조림을 챙겼다", tags: ["theft"], severity: 1, privacy: "private", noisy: false, condition: "always" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const deed = Object.values(w.state().deeds).at(-1)!;
    if (!deed.witnesses.some((x) => w.state().characters[x.npcId]?.factionId === "faction_c")) expect(alarmOpen(w)).toBe(false);
  });
});

describe("잠으로 낫는 간격 (12-266)", () => {
  it("중상은 다친 뒤 하룻밤으로는 낫지 않고, 이틀이 지나면 자고 나서 한 단계 아문다", () => {
    const w = make("role_a_grunt");
    const harm = content.scenario.harm_track;
    w.runCheat("~harm 서진 serious");
    w.runCheat("~time night");
    w.executeTool("take_action", act({ activity: { kind: "sleep", until: null, hours: 8 } }));
    expect(w.state().characters[w.state().playerId]!.conditions[harm]).toBe("serious");
    w.runCheat("~time night");
    w.executeTool("take_action", act({ activity: { kind: "sleep", until: null, hours: 8 } }));
    expect(w.state().characters[w.state().playerId]!.conditions[harm]).toBe("light");
  });
});
