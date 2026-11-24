import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryletContent } from "../content/schemas.ts";
import { checkResolveSpine } from "../content/loader.ts";
import { applyEvent } from "../game/state.ts";
import { knownCrossings } from "../rules/knowledge.ts";
import { storyPlacesFit } from "../rules/place.ts";
import { fitForPractice } from "../rules/situation.ts";
import { castCandidates, conditionsMet, pacingBlocks, storyletAllowed } from "../story/storylets.ts";
import { loadRealContent, atEntry } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { waterHere } from "./body.ts";

/** 플레이 테스트 14 뒤 정한 것 (12-251) */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };
const world = (roleId: string, roll = 0.5) => atEntry(new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-251-")), content, rngFactory: () => () => roll }).create("mcp", roleId, choice));
const act = (input: Record<string, unknown> = {}) => ({ intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
const story = (base: StoryletContent, patch: Partial<StoryletContent> & { when?: Partial<StoryletContent["when"]> }): StoryletContent => ({ ...base, ...patch, when: { ...base.when, ...(patch.when ?? {}) } }) as StoryletContent;

describe("몸 (12-251)", () => {
  it("물림 감염은 60%, 금단은 진통제 사흘·각성제 이레", () => {
    expect(content.scenario.body?.infection?.chance.bite).toBe(0.6);
    const habit = (id: string) => content.scenario.traits.find((t) => t.id === id)?.effects.habit?.quit_days;
    expect(habit("pill_habit")).toBe(3);
    expect(habit("stim_habit")).toBe(7);
  });
});

describe("판정 (12-251)", () => {
  it("무너진 자세는 장소나 구역을 옮기면 풀린다", () => {
    const w = world("role_a_grunt");
    const s = { ...w.state(), offBalanceUntil: w.state().time + 60 };
    expect(applyEvent(s, { type: "place_moved", from: null, to: "barracks" } as never).offBalanceUntil).toBeNull();
    expect(applyEvent(s, { type: "zone_moved", from: s.playerZone, to: "old_town" } as never).offBalanceUntil).toBeNull();
  });
});

describe("이야기 전제 (12-251)", () => {
  it("이야기 글이 말하는 장소와 지금 장소가 다르면 열지 않는다. 막 들어선 자리에서는 거르지 않는다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    expect(s.playerZone).toBe("a_base");
    const text = "식당 천막에서 솥을 젓던 사람이 말을 건다";
    s.playerPlace = null;
    expect(storyPlacesFit(s, content, undefined, text)).toBe(true);
    s.playerPlace = "barracks";
    expect(storyPlacesFit(s, content, undefined, text)).toBe(false);
    s.playerPlace = "mess";
    expect(storyPlacesFit(s, content, undefined, text)).toBe(true);
    // 적어 둔 places가 먼저다
    expect(storyPlacesFit(s, content, ["barracks"], text)).toBe(false);
    // 장소를 말하지 않는 이야기는 어디서나
    s.playerPlace = "barracks";
    expect(storyPlacesFit(s, content, undefined, "누군가 어깨를 두드린다")).toBe(true);
  });

  it("같은 장소를 말하는 이야기는 하루에 하나", () => {
    const w = world("role_b_guard");
    const s = w.state();
    // 글자 맞추기를 보는 테스트라 장소·종류를 적지 않은 이야기를 틀로 (12-300)
    const base = Object.values(content.storylets).find((x) => !x.essential && !x.when.mission && !x.when.places && !x.when.place_kinds)!;
    const a = story(base, { id: "test_well_a", setup: "우물가에서 두레박이 긁힌다" });
    const b = story(base, { id: "test_well_b", setup: "우물 앞에 줄이 길다" });
    const c = { ...content, storylets: { ...content.storylets, [a.id]: a, [b.id]: b } };
    s.storyletLog = { ...s.storyletLog, [a.id]: { fired: 1, lastFiredAt: s.time } } as never;
    expect(pacingBlocks(s, c, b, s.time)).toBe(true);
    expect(pacingBlocks(s, c, story(base, { id: "test_gate", setup: "정문 앞에 사람이 섰다" }), s.time)).toBe(false);
  });

  it("연습 대련은 경상까지만, 신병은 젊은 사람만", () => {
    const w = world("role_a_grunt");
    const me = w.state().characters[w.state().playerId]!;
    me.conditions.harm = "light";
    expect(fitForPractice(w.state(), content)).toBe(true);
    me.conditions.harm = "serious";
    expect(fitForPractice(w.state(), content)).toBe(false);
    const rookie = content.storylets.os_rookie_assigned ?? Object.values(content.storylets).find((x) => Object.values(x.cast).some((r) => r.age_lte !== undefined))!;
    const role = Object.values(rookie.cast).find((r) => r.age_lte !== undefined)!;
    for (const id of castCandidates(w.state(), content, role)) expect(w.state().characters[id]!.age ?? 99).toBeLessThanOrEqual(role.age_lte!);
  });

  it("앞 이야기에서 정한 시간이 지나야 열린다 (튜토리얼: 하룻밤 담 밖에서)", () => {
    const w = world("role_t_visitor");
    const s = w.state();
    const again = content.storylets.tv_gate_again!;
    const probe = story(again, { when: { after_storylet: again.when.after_storylet } as never });
    const bare = { ...probe, when: { after_storylet: again.when.after_storylet } } as StoryletContent;
    expect(conditionsMet(s, content, bare, s.time)).toBe(false); // 정문 이야기가 아직 없다
    s.storyletLog = { ...s.storyletLog, tv_gate: { fired: 1, lastFiredAt: s.time } } as never;
    expect(conditionsMet(s, content, bare, s.time + 2 * 60)).toBe(false);
    expect(conditionsMet(s, content, bare, s.time + 12 * 60)).toBe(true);
  });

  it("튜토리얼 안내는 자는 사람을 깨우지 않는다", () => {
    const w = world("role_t_visitor");
    const settle = content.storylets.tv_settle!;
    expect(settle.wakes).toBe(false);
    expect(storyletAllowed(w.state(), content, settle, "open", w.state().time, { urgentOnly: true })).toBe(false);
    expect(storyletAllowed(w.state(), content, settle, "open", w.state().time)).toBe(true);
  });

  it("다짐(진실 알기)의 줄기 이야기는 꼭 열리는 이야기다 (의회 저장고)", () => {
    expect(content.storylets.y_storehouse!.essential).toBe(true);
    expect(checkResolveSpine(content)).toEqual([]);
    const broken = { ...content, storylets: { ...content.storylets, y_storehouse: { ...content.storylets.y_storehouse!, essential: false } } };
    expect(checkResolveSpine(broken).join("\n")).toContain("y_storehouse");
  });
});

describe("도구·콘텐츠 (12-251)", () => {
  it("섬에서 나갈 길은 스스로 모르고, 밤배를 보면 안다", () => {
    const w = world("role_y_islander");
    const s = w.state();
    expect(s.playerZone).toBe("yeoul_isle");
    expect(knownCrossings(s, content, "yeoul_isle")).toEqual([]);
    s.flags = { ...s.flags, [s.playerId]: [...(s.flags[s.playerId] ?? []), "y_rocks_seen"] };
    expect(knownCrossings(s, content, "yeoul_isle")).toContain("riverside");
    expect(w.sceneForGm()).toContain("건너는 길");
  });

  it("물이 나지 않던 구역에도 끓이지 않은 물을 뜰 곳이 있다", () => {
    const w = world("role_l_wanderer");
    w.state().playerZone = "old_town";
    expect(waterHere(content, w.state())).toMatchObject({ kind: "spring", where: "구시가를 가로지르는 개천" });
    w.state().playerZone = "hospital_ruins";
    expect(waterHere(content, w.state())).toBeNull();
  });

  it("장소마다 묘사가 있다", () => {
    for (const loc of Object.values(content.locations)) for (const p of loc.places) expect(p.description, `${loc.id}.${p.id}`).toBeTruthy();
  });

  it("빚 걷기: 판정에 성공하면 받은 것이 손에 들어오고, 보고 때 건네야 완수다. 숨기면 일부 완수", () => {
    const run = (hide: boolean) => {
      const w = world("role_e_porter", 0.99);
      const commander = content.roles.role_e_porter!.commander!;
      w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
      w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["e_debt_run"] });
      const got = w.executeTool("assign_mission", { template_id: "e_debt_run" });
      expect(got.ok, got.ok ? "" : got.error).toBe(true);
      // 12-302: 장터와 강변 사이에 길목(강둑 나루길)이 생겼다
      w.executeTool("take_action", act({ move_to: "ferry_levee", for_mission: true }));
      w.state().activeStorylet = null;
      const go = w.executeTool("take_action", act({ move_to: "riverside", for_mission: true }));
      expect(go.ok, go.ok ? "" : go.error).toBe(true);
      w.state().activeStorylet = null;
      const talk = w.executeTool("take_action", act({ intent: "빚을 받는다", activity: { kind: "talk", until: null }, check: { move: "persuade", stat: "charm", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" }, for_mission: true }));
      expect(talk.ok, talk.ok ? "" : talk.error).toBe(true);
      expect(talk.ok && talk.resultText).toContain("받아 냈다");
      expect(w.state().characters[w.state().playerId]!.inventory.dried_fish ?? 0).toBeGreaterThanOrEqual(2);
      if (hide) w.state().characters[w.state().playerId]!.inventory.dried_fish = 0;
      // 대화 30분을 채운다
      for (let i = 0; i < 3; i++) {
        w.state().activeStorylet = null;
        w.executeTool("take_action", act({ intent: "더 이야기한다", activity: { kind: "talk", until: null }, for_mission: true }));
      }
      const m = Object.values(w.state().missions).at(-1)!;
      expect(m.requirements.every((_, i) => (m.progress[i] ?? 0) >= 1), JSON.stringify(m.progress)).toBe(true);
      w.state().activeStorylet = null;
      w.executeTool("take_action", act({ move_to: "ferry_levee" }));
      w.state().activeStorylet = null;
      w.executeTool("take_action", act({ move_to: "e_market" }));
      w.state().activeStorylet = null;
      if (!w.state().scene.present.includes(commander)) w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
      const report = w.executeTool("report_mission", {});
      expect(report.ok, report.ok ? "" : report.error).toBe(true);
      return Object.values(w.state().missions).at(-1)!.status;
    };
    expect(run(false)).toBe("completed");
    expect(run(true)).toBe("partial");
  });
});
