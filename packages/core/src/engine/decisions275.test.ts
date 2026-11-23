import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npcPlaceAt, sceneLeavesAt } from "../rules/place.ts";
import { segmentOf } from "../rules/time.ts";
import type { GameState } from "../game/state.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 시간대마다 장면 비우기 (12-275, B④). 실제 콘텐츠로 본다 */
const content = loadRealContent();
const make = () =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-275-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_a_grunt", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const at = (s: GameState, segment: string) => {
  const day = s.time - (s.time % 1440) + 1440;
  for (let t = day; t < day + 1440; t += 30) if (segmentOf(t) === segment) return t;
  throw new Error(segment);
};

describe("시간대마다 장면 비우기 (12-275)", () => {
  it("시간대가 바뀌면 제자리가 다른 사람은 빠지고, 제자리가 여기인 사람·이번 행동의 상대·동행은 남는다", () => {
    const w = make();
    const s0 = w.state();
    const morning = at(s0, "morning");
    const day = at(s0, "day");
    const here = { ...s0, playerZone: "a_base", playerPlace: "barracks", time: day };
    const people = Object.values(content.npcs).filter((n) => n.zone === "a_base" && !n.roams?.length && !s0.characters[n.id]?.dead).map((n) => n.id);
    const elsewhere = people.find((id) => npcPlaceAt(here, content, id) && npcPlaceAt(here, content, id) !== "barracks")!;
    const home = people.find((id) => npcPlaceAt(here, content, id) === "barracks");
    const scene = { ...here, scene: { ...here.scene, present: [elsewhere, ...(home ? [home] : [])] } };
    expect(sceneLeavesAt(scene, content, morning)).toEqual([elsewhere]);
    // 이번 행동이 겨눈 사람은 남는다
    expect(sceneLeavesAt(scene, content, morning, [elsewhere])).toEqual([]);
    // 시간대가 그대로면 비우지 않는다
    expect(sceneLeavesAt({ ...scene, time: day + 60 }, content, day)).toEqual([]);
    // 동행은 남는다
    expect(sceneLeavesAt({ ...scene, companions: [elsewhere] }, content, morning)).toEqual([]);
  });

  it("시간을 흘리면 결과에 '제 할 일로 자리를 떴다'가 나온다", () => {
    const w = make();
    w.ctx().store.append({ type: "place_moved", from: w.state().playerPlace, to: "barracks" });
    const people = Object.values(content.npcs).filter((n) => n.zone === "a_base" && !n.roams?.length && !w.state().characters[n.id]?.dead).map((n) => n.id);
    const elsewhere = people.find((id) => {
      const later = { ...w.state(), time: w.state().time + 6 * 60 };
      return npcPlaceAt(later, content, id) && npcPlaceAt(later, content, id) !== "barracks";
    })!;
    w.executeTool("npc_presence", { npc_id: elsewhere, action: "enter" });
    const r = w.executeTool("take_action", { intent: "기다린다", check: null, activity: { kind: "wait", hours: 6 }, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().scene.present).not.toContain(elsewhere);
    expect(r.ok && r.resultText).toContain("제 할 일로 자리를 떴다");
  });
});
