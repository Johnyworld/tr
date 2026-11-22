import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { peopleAt, whereIs } from "../rules/place.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { carriedWeight, carryCapacity } from "./gear.ts";
import { recordDeed } from "./reputationTools.ts";

/**
 * 플레이 테스트 17 뒤 고친 것 (12-262). 실제 경로(세계 만들기·도구 호출)로 본다:
 * 12-261의 고침 셋이 함수를 직접 부른 테스트만 통과하고 실제로는 돌지 않았다
 */
const content = loadRealContent();
const make = (roleId: string, extra: Record<string, unknown> = {}, roll = 0.5) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-262-")), content, rngFactory: () => () => roll }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [], ...extra } as never);
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ignore_story: true, ...input });

describe("실제 경로로 도는가 (12-262)", () => {
  it("세계를 만들면 시작 짐이 한도 안이다 (넘치면 사물함·시작 자리에)", () => {
    for (const roll of [0.05, 0.5, 0.95]) {
      const w = make("role_t_visitor", { name: "민재", gender: "male", past: "courier" }, roll);
      const me = w.state().characters[w.state().playerId]!;
      expect(carriedWeight(content, me), `roll ${roll}`).toBeLessThanOrEqual(carryCapacity(content, me, w.state()));
    }
  });

  it("규율 회의로 불려 가면 결과 글에 한 줄", () => {
    const w = make("role_c_raider");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_c" && whereIs(w.state(), content, n.id)?.zone === w.state().playerZone && n.id !== content.roles.role_c_raider!.commander)!.id;
    w.executeTool("npc_presence", { npc_id: mate, action: "enter" });
    w.executeTool("take_action", act({ deed: { summary: "무리 창고에서 통조림을 훔쳤다", tags: ["theft"], severity: 2, privacy: "semi_private", noisy: false, condition: "always" } }));
    const r = w.executeTool("take_action", act({ activity: { kind: "wait", until: null, hours: 2 }, ignore_story: false }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (w.state().activeStorylet?.id === "disc_c_council") expect(r.ok && r.resultText).toContain("불려 갔다");
  });

  it("떨어져 기다리게 한 동행은 그 자리에 있다 (companion_part를 거쳐)", () => {
    const w = make("role_a_squad_leader");
    const mate = Object.values(content.npcs).find((n) => w.state().scene.present.includes(n.id))!.id;
    const ordered = w.executeTool("squad_order", { members: [mate], task: "follow", zone: null });
    expect(ordered.ok, ordered.ok ? "" : ordered.error).toBe(true);
    const here = w.state().playerPlace;
    const parted = w.executeTool("companion_part", { target: mate, how: "wait", hours: null });
    expect(parted.ok, parted.ok ? "" : parted.error).toBe(true);
    w.executeTool("take_action", act({ place_to: "barracks" }));
    expect(whereIs(w.state(), content, mate)?.place).toBe(here);
  });

  it("재회한 가족은 집의 사람 목록에 보인다", () => {
    const w = make("role_t_visitor", { name: "민재", gender: "male" });
    const family = Object.values(w.state().characters).filter((c) => c.extra?.place === "blocks").map((c) => c.id);
    expect(family.length).toBeGreaterThan(0);
    expect(peopleAt(w.state(), content, "b_base", "blocks")).toEqual(expect.arrayContaining(family));
  });
});

describe("줄기·마음 (12-262)", () => {
  it("꼭 열리는 이야기는 실패로 끝났으면 하루 뒤 다시 후보가 된다", () => {
    const w = make("role_t_visitor", { name: "민재", gender: "male" });
    w.runCheat("~goto a_base");
    const s = w.state();
    const id = "tv_gate";
    const at = s.time + 2 * 24 * 60;
    const withEnd = (lastEnd: string) => ({ ...s, storyletLog: { ...s.storyletLog, [id]: { fired: 1, lastFiredAt: s.time, lastEnd } } });
    expect(eligibleStorylets(withEnd("chosen"), content, at).some((x) => x.id === id)).toBe(false);
    const before = eligibleStorylets({ ...s, storyletLog: {} }, content, at).some((x) => x.id === id);
    expect(eligibleStorylets(withEnd("miss"), content, at).some((x) => x.id === id)).toBe(before);
  });

  it("당한 사람은 가치관으로 마음이 오르지 않는다", () => {
    const w = make("role_a_grunt");
    const npc = Object.values(content.npcs).find((n) => whereIs(w.state(), content, n.id)?.zone === w.state().playerZone)!.id;
    w.executeTool("npc_presence", { npc_id: npc, action: "enter" });
    const { deed } = recordDeed(w.ctx(), { summary: "주머니를 털었다", tags: ["theft"], severity: 2, privacy: "semi_private", noisy: false, victim: npc });
    const learned = w.ctx().store.getState().deedKnowledge;
    void learned;
    expect(deed.witnesses.some((x) => x.npcId === npc)).toBe(true);
    const rel = w.state().relations[npc]?.[w.state().playerId] ?? { trust: 0, affection: 0, respect: 0 };
    expect(rel.trust).toBeLessThanOrEqual(0);
    expect(rel.affection).toBeLessThanOrEqual(0);
  });
});
