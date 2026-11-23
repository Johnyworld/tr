import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placesIn, whereIs } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 구역·장소 혼동 버그 (12-268). 실제 경로로 본다 */
const content = loadRealContent();
const make = (roleId: string) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-268-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("구역·장소 (12-268)", () => {
  it("옮겨 가는 장소에 있는 사람을 with로 부를 수 있다", () => {
    const w = make("role_a_grunt");
    const s = w.state();
    const pick = Object.keys(content.npcs).map((id) => ({ id, at: whereIs(s, content, id) })).find((x) => x.at?.zone === s.playerZone && x.at.place && x.at.place !== s.playerPlace && !s.scene.present.includes(x.id));
    expect(pick).toBeTruthy();
    const r = w.executeTool("take_action", act({ place_to: pick!.at!.place, with: [pick!.id] }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().scene.present).toContain(pick!.id);
  });

  it("기다리라고 둔 동행은 그 장소로 돌아와야 합류한다 (구역 입구에서는 아니다)", () => {
    const w = make("role_a_squad_leader");
    const mate = Object.values(content.npcs).find((n) => w.state().scene.present.includes(n.id))!.id;
    w.executeTool("squad_order", { members: [mate], task: "follow", zone: null });
    const here = w.state().playerPlace!;
    expect(here).toBeTruthy();
    w.executeTool("companion_part", { target: mate, how: "wait", hours: null });
    const other = placesIn(w.state(), content, w.state().playerZone).find((p) => p.id !== here && !p.jail)!.id;
    w.executeTool("take_action", act({ place_to: other }));
    w.executeTool("take_action", act({ place_to: "entry" }));
    expect(w.state().companions.includes(mate) && !w.state().bonds[mate]?.apart).toBe(false);
    w.executeTool("take_action", act({ place_to: here }));
    expect(w.state().bonds[mate]?.apart).toBeFalsy();
  });

  it("다른 장소에 있을 사람을 npc_presence로 들이면 그 사람이 보통 어디 있는지 알린다", () => {
    const w = make("role_a_grunt");
    const s = w.state();
    const pick = Object.keys(content.npcs).map((id) => ({ id, at: whereIs(s, content, id) })).find((x) => x.at?.zone === s.playerZone && x.at.place && x.at.place !== s.playerPlace && !s.scene.present.includes(x.id) && !s.companions.includes(x.id));
    const r = w.executeTool("npc_presence", { npc_id: pick!.id, action: "enter" });
    expect(r.ok && r.resultText).toContain("보통 지금");
  });
});
