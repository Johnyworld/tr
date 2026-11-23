import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heldOf } from "../rules/held.ts";
import { fireLitHere } from "../rules/place.ts";
import { knowAllPlaces, loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";

/** 플레이 테스트 19 뒤 고친 것 (12-267). 실제 경로(세계 만들기·도구 호출)로 본다 */
const content = loadRealContent();
const make = (roleId: string, extra: Record<string, unknown> = {}) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-267-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [], ...extra } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });
const sceneText = (w: ReturnType<typeof make>) => w.sceneForGm();

describe("정보 누설 (12-267)", () => {
  it("갇힌 사람이 있는 구역에 들어서도 그 사람의 지금 모습은 장면에서 보기 전에는 실리지 않는다", () => {
    const w = make("role_a_grunt");
    const captive = Object.values(w.state().characters).find((c) => c.factionId === "faction_a" && heldOf(c) && content.npcs[c.id]?.look)!;
    w.runCheat(`~goto ${heldOf(captive)!.zone}`);
    expect(sceneText(w)).not.toContain(content.npcs[captive.id]!.look);
  });

  it("가족이 사는 집은 그 사람을 만나기 전에는 장소 목록에 안 보인다", () => {
    const w = make("role_t_visitor", { name: "민재", gender: "male" });
    const family = Object.values(w.state().characters).filter((c) => c.extra?.place === "blocks");
    expect(family.length).toBeGreaterThan(0);
    w.runCheat("~goto b_base");
    const line = sceneText(w).split("\n").find((l) => l.startsWith("- blocks")) ?? "";
    for (const c of family) expect(line).not.toContain(c.name);
  });
});

describe("판정·불 (12-267)", () => {
  it("시스템이 굴린 버티는 판정은 이야기 선택지의 판정으로 쓰이지 않는다", () => {
    const w = make("role_b_guard");
    w.runCheat("~storylet b_fence_drawn");
    expect(w.state().activeStorylet?.id).toBe("b_fence_drawn");
    const s = w.state();
    w.ctx().store.append({ type: "check_rolled", checkId: `chk_${s.nextCheckNo}`, turn: s.turn, actorId: s.playerId, move: "endure", stat: "nerve", difficulty: "normal", intent: "마음을 다잡는다", dice: [3, 3], modifiers: { stat: 0, skill: 0, difficulty: 0, condition: 0, trait: 0, gear: 0, opposition: 0 }, total: 6, outcome: "miss", reaction: true });
    const r = w.executeTool("resolve_storylet", { choice_id: "wait" });
    expect(r.ok).toBe(false);
  });

  it("막 들어선 자리에 피운 불은 같은 구역의 다른 장소를 데우지 않는다", () => {
    const w = make("role_t_visitor", { name: "민재", gender: "male" });
    w.runCheat("~goto a_base");
    knowAllPlaces(w, content);
    w.runCheat("~give firewood 1");
    const lit = w.executeTool("take_action", act({ use_item: "firewood" }));
    expect(lit.ok, lit.ok ? "" : lit.error).toBe(true);
    expect(fireLitHere(w.state())).toBe(true);
    w.executeTool("take_action", act({ place_to: "mess" }));
    expect(fireLitHere(w.state())).toBe(false);
    expect(sceneText(w)).not.toContain("모닥불 +");
  });
});
