import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import { createContentSchemas, type Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { createSeededRng } from "../rng.ts";
import { loadRealContent, TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { isConfused } from "./ambush.ts";
import { learn } from "./reputationTools.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { fillStorylet } from "../story/storylets.ts";
import { sentence } from "../text.ts";
import { commanderOf, pickDailyOffers } from "../game/missions.ts";
import { dedupeAlias } from "../story/storylets.ts";
import { watchers } from "./opposition.ts";
import { runDailyBody } from "./body.ts";
import { scarFromHarm } from "./scars.ts";
import { harmSteps } from "./action.ts";
import { naturalLimit } from "../rules/check.ts";
import { conditionsMet } from "../story/storylets.ts";

/** 긴 판 열의 원문 보고서에서 다시 모은 버그 (플레이 테스트 11, 12-202) */
const storyletSchema = createContentSchemas(TEST_SCENARIO).storylet;

function setup(storylets: unknown[], edit?: (c: Content) => void) {
  const c: Content = structuredClone(TEST_CONTENT);
  for (const f of Object.values(c.factions)) {
    f.aggression = 0;
    f.plans = [];
  }
  c.scenario.storylet_pacing = { min_gap_hours: 6, expire_hours: 3, first_after_hours: 0, min_any_gap_hours: 0, urgent_per_day: 0, urgent_only_when: {}, per_day: 0, threat_per_day: 0, road_per_day: 0, same_threat_gap_days: 0 };
  c.storylets = Object.fromEntries(storylets.map((s) => storyletSchema.parse(s)).map((s) => [s.id, s]));
  edit?.(c);
  const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_test")]);
  const ctx = { store, rng: createSeededRng(3), content: c };
  const opened = runAfterTimeAdvance(ctx);
  return { store, ctx, opened };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("플레이 테스트 11 원문의 버그", () => {
  it("이야기 선택지가 내놓게 하는 물건을 배역에게 먼저 건네면 선택지로 안내한다", () => {
    const env = setup([
      {
        id: "cough",
        title: "기침",
        cast: { sick: { ids: ["npc_leader"] } },
        setup: "{sick:이/가} 기침을 한다.",
        choices: [
          { id: "give", label: "물병을 건넨다", effects: [{ take_item: { item: "water_bottle" } }] },
          { id: "pass", label: "지나친다", effects: [] },
        ],
      },
    ]);
    expect(env.store.getState().activeStorylet?.id).toBe("cough");
    const s = env.store.getState();
    const r = executeTool("transfer_item", { from: s.playerId, to: "npc_leader", item_id: "water_bottle", quantity: 1 }, env.ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("resolve_storylet give");
    expect(env.store.getState().characters[s.playerId]!.inventory.water_bottle).toBe(1);
  });

  it("이야기 제목에 주인공이 모르는 이름이 있으면 호칭으로 가린다", () => {
    const name = TEST_CONTENT.npcs.npc_stranger!.name;
    const env = setup([{ id: "notebook", title: `${name}의 공책`, setup: "공책이 떨어져 있다.", choices: [{ id: "ok", label: "줍는다", effects: [] }] }]);
    const started = env.opened.find((d) => d.type === "storylet" && d.event === "started");
    expect(started && "title" in started ? started.title : "").not.toContain(name);
  });

  it("이동하며 물을 채우려 하면 시간을 쓰기 전에 거절한다", () => {
    const env = setup([]);
    const before = env.store.getState().time;
    const r = executeTool("take_action", act({ move_to: "a_post", refill: true }), env.ctx);
    expect(r.ok).toBe(false);
    expect(env.store.getState().time).toBe(before);
    expect(env.store.getState().playerZone).toBe("a_home");
  });

  it("매복의 혼란은 오래 쉬면 가신다", () => {
    const env = setup([]);
    const id = env.store.getState().playerId;
    env.store.append({ type: "confusion_changed", characterId: id, on: true });
    expect(isConfused(env.store.getState(), id)).toBe(true);
    executeTool("take_action", act({ activity: { kind: "wait", until: null } }), env.ctx);
    expect(isConfused(env.store.getState(), id)).toBe(false);
  });

  it("끼니 활동만으로는 허기가 풀리지 않는다고 알린다", () => {
    const env = setup([]);
    const r = executeTool("take_action", act({ activity: { kind: "eat", until: null } }), env.ctx);
    expect(r.ok && r.resultText).toContain("use_item");
  });

  it("적에게 베푼 호의는 받은 쪽(다른 무리)의 신뢰를 깎지 않는다", () => {
    const env = setup([], (c) => {
      c.npcs.npc_leader!.values = { ...c.npcs.npc_leader!.values, loyalty: 2 };
      c.npcs.npc_stranger!.values = { ...c.npcs.npc_stranger!.values, loyalty: 2 };
    });
    const s = env.store.getState();
    const deed = { id: "d_test", actorId: s.playerId, summary: "포로에게 물을 건넸다", tags: ["enemy_sympathy" as const], severity: 2, at: s.time, witnesses: [], searched: false };
    env.store.append({ type: "deed_recorded", deed });
    learn(env.ctx, deed, "npc_leader", "seen");
    learn(env.ctx, deed, "npc_stranger", "seen");
    const after = env.store.getState().relations;
    expect(after.npc_leader?.[s.playerId]?.trust ?? 0).toBeLessThan(0);
    expect(after.npc_stranger?.[s.playerId]?.trust ?? 0).toBe(0);
  });

  it("한 글에 같은 호칭이 거듭 나오면 두 번째부터 끝 낱말만 쓴다", () => {
    const out = fillStorylet("{x:이/가} 다가온다. {x:은/는} 웃는다.", { x: "계급장 자국만 남은 벌조장" });
    expect(out).toBe("계급장 자국만 남은 벌조장이 다가온다. 벌조장은 웃는다.");
  });

  it("따옴표로 끝난 말 뒤에 마침표를 겹치지 않는다", () => {
    expect(sentence('"살아남았잖아."')).toBe('"살아남았잖아."');
    expect(sentence("살아남았다")).toBe("살아남았다.");
  });

  it("찾아오기 임무는 보고할 때 그 자원의 물건을 건네야 채운다", () => {
    const run = (hold: boolean) => {
      const env = setup([], (c) => {
        c.items.tin = { id: "tin", name: "통조림", resource: "food" };
        c.missions.m_fetch = { id: "m_fetch", title: "식량 찾아오기", briefing: "먹을 것을 찾아 온다", giver_rank: "squad_leader", deadline_hours: 12, requirements: [{ bring: "food", quantity: 1 }] };
        c.roles.role_test!.missions = ["m_fetch"];
      });
      const me = env.store.getState().playerId;
      if (hold) env.store.append({ type: "item_granted", to: me, itemId: "tin", quantity: 2 });
      executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
      expect(executeTool("assign_mission", { template_id: "m_fetch" }, env.ctx).ok).toBe(true);
      const r = executeTool("report_mission", {}, env.ctx);
      return { r, left: env.store.getState().characters[me]!.inventory.tin ?? 0 };
    };
    const got = run(true);
    expect(got.r.ok && got.r.resultText).toContain("완수");
    expect(got.r.ok && got.r.resultText).toContain("통조림 ×1");
    expect(got.left).toBe(1);
    const none = run(false);
    expect(none.r.ok && none.r.resultText).toContain("채우지 못한 것");
  });

  it("데려오기 임무의 결과 조건은 그 임무 자리의 이야기로만 채운다", () => {
    const env = setup(
      [
        {
          id: "found",
          title: "찾은 사람",
          urgent: true,
          repeatable: true,
          when: { mission: ["m_bring"] },
          setup: "사람이 있다.",
          choices: [{ id: "bring", label: "데려간다", effects: [{ mission_goal: true }] }],
        },
      ],
      (c) => {
        c.missions.m_bring = { id: "m_bring", title: "데려오기", briefing: "데려온다", giver_rank: "squad_leader", deadline_hours: 12, requirements: [{ goal: "그 사람을 데려온다" }] };
        c.roles.role_test!.missions = ["m_bring"];
      },
    );
    expect(env.store.getState().activeStorylet).toBeFalsy();
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, env.ctx);
    executeTool("assign_mission", { template_id: "m_bring" }, env.ctx);
    runAfterTimeAdvance(env.ctx);
    expect(env.store.getState().activeStorylet?.id).toBe("found");
    expect(executeTool("resolve_storylet", { choice_id: "bring" }, env.ctx).ok).toBe(true);
    const r = executeTool("report_mission", {}, env.ctx);
    expect(r.ok && r.resultText).toContain("완수");
    expect(r.ok && r.resultText).not.toContain("채우지 못한 것");
  });

  it("빼앗긴 우리 땅으로 가는 임무는 내지 않는다", () => {
    const c: Content = structuredClone(TEST_CONTENT);
    c.missions.m_post = { id: "m_post", title: "초소 증원", briefing: "초소로 간다", giver_rank: "squad_leader", deadline_hours: 12, where: "a_post", requirements: [{ activity: "guard_duty", minutes: 60 }] };
    c.roles.role_test!.missions = ["m_post", "m_guard"];
    const ours = pickDailyOffers(c, "role_test", 1440, null, () => 0, [], false, { factionId: "faction_a", owners: { a_post: { owner: "faction_a" } } })!;
    expect(ours.templateIds).toContain("m_post");
    const lost = pickDailyOffers(c, "role_test", 1440, null, () => 0, [], false, { factionId: "faction_a", owners: { a_post: { owner: "faction_c" } } })!;
    expect(lost.templateIds).not.toContain("m_post");
  });

  it("진급해 상관과 계급이 같아지면 그 계급 역할에 정해진 상관을 먼저 쓴다", () => {
    const content = {
      roles: { r1: { commander: "boss", faction: "f", rank: "grunt" }, r2: { commander: "chief", faction: "f", rank: "squad_leader" } },
      scenario: { rank_ladder: [{ id: "grunt", level: 1 }, { id: "squad_leader", level: 2 }, { id: "officer", level: 3 }] },
    };
    const state = {
      playerId: "me",
      roleId: "r1",
      characters: {
        me: { dead: false, rank: "squad_leader", factionId: "f" },
        boss: { dead: false, rank: "squad_leader", factionId: "f" },
        aaa: { dead: false, rank: "officer", factionId: "f" },
        chief: { dead: false, rank: "officer", factionId: "f" },
      },
    };
    expect(commanderOf(state, content)).toBe("chief");
  });

  it("적에게서 숨을 때 곁의 아군은 지켜보는 눈이 아니다", () => {
    const env = setup([]);
    const s = env.store.getState();
    for (const id of ["npc_leader", "npc_stranger"]) env.store.append({ type: "npc_entered", npcId: id });
    const after = env.store.getState();
    expect(watchers(after)).toEqual(expect.arrayContaining(["npc_leader", "npc_stranger"]));
    const foe = after.characters.npc_stranger!;
    expect(watchers(after, foe)).not.toContain("npc_leader");
    expect(watchers(after, foe)).toContain("npc_stranger");
    expect(s.playerId).toBeTruthy();
  });

  it("직함이 호칭의 끝 낱말과 같은 말로 끝나면 직함을 뺀다", () => {
    expect(dedupeAlias("문을 연 것은 경비조장 ", "경비실 모자를 쓴 반백의 조장")).toEqual({ before: "문을 연 것은 ", value: "경비실 모자를 쓴 반백의 조장" });
    expect(dedupeAlias("알게 된 것: 지도장수 ", "지도통을 멘 소식장수").before).toBe("알게 된 것: ");
    expect(dedupeAlias("경비조장 ", "배동철")).toEqual({ before: "경비조장 ", value: "배동철" });
  });

  it("배가 고프면 자정에 지닌 먹을 것을 하나 먹는다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-eat-")), content: loadRealContent(), rngFactory: () => () => 0.5 }).create("mcp", "role_l_wanderer");
    const me = () => w.state().characters[w.state().playerId]!;
    me().inventory = { canned_food: 1 };
    me().conditions.hunger = "hungry";
    runDailyBody(w.ctx());
    expect(me().inventory.canned_food ?? 0).toBe(0);
  });

  it("이야기 조건: 하던 일·동행 수·이 구역이 아닐 때", () => {
    const env = setup([]);
    const st = (when: Record<string, unknown>) => storyletSchema.parse({ id: "x", title: "x", setup: "x", when, choices: [{ id: "a", label: "a", effects: [] }] });
    const s = env.store.getState();
    const asleep = { ...s, lastActivity: "sleep" };
    expect(conditionsMet(asleep, env.ctx.content, st({ activities_none: ["sleep"] }), s.time)).toBe(false);
    expect(conditionsMet(s, env.ctx.content, st({ activities_none: ["sleep"] }), s.time)).toBe(true);
    expect(conditionsMet(asleep, env.ctx.content, st({ activities: ["sleep"] }), s.time)).toBe(true);
    expect(conditionsMet({ ...s, companions: ["npc_leader"] }, env.ctx.content, st({ companions_lte: 0 }), s.time)).toBe(false);
    expect(conditionsMet(s, env.ctx.content, st({ zones_none: [s.playerZone!] }), s.time)).toBe(false);
  });

  it("상처 원인이 부위를 말하면 그 부위에 맞는 흉터만 남는다", () => {
    for (let i = 0; i < 6; i++) {
      const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scar-")), content: loadRealContent(), rngFactory: () => () => (i + 0.5) / 6 * 0.29 }).create("mcp", "role_a_grunt");
      const me = () => w.state().characters[w.state().playerId]!;
      me().conditions.harm = "critical";
      const line = scarFromHarm(w.ctx(), me().id, "blunt", "선반이 무너져 팔과 어깨를 다쳤다");
      expect(line ?? "").not.toContain("짧은 숨");
      expect(line ?? "").not.toContain("먹은 귀");
    }
  });

  it("대가 있는 성공은 실패보다 피해가 한 단계 덜하다 (가벼운 위험이면 다치지 않는다)", () => {
    expect([harmSteps("partial", "light"), harmSteps("partial", "heavy"), harmSteps("miss", "light"), harmSteps("miss", "heavy")]).toEqual([0, 1, 1, 2]);
  });

  it("다른 무리 치료사는 값을 받는다. 거점에서는 무리 창고의 의약품을, 거점 밖에서는 치료사·곁의 동료가 지닌 약을 쓴다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-heal-")), content: loadRealContent(), rngFactory: () => () => 0.5 }).create("mcp", "role_l_wanderer");
    const me = () => w.state().characters[w.state().playerId]!;
    const healer = () => w.state().characters.a_chaewon!;
    const stock = () => w.state().factions[healer().factionId!]!.resources.medicine ?? 0;
    const treat = () => w.executeTool("take_action", { intent: "치료를 받는다", treatment: { item: null, target: null, pay: "auto" } });
    // 거점 밖: 치료사가 지닌 약이 없으면 못 한다, 있으면 그것을 쓴다
    w.state().scene.present.push("a_chaewon");
    me().conditions.harm = "light";
    me().inventory = { canned_food: 6 };
    healer().inventory = {};
    expect(treat().ok).toBe(false);
    healer().inventory = { bandage: 1 };
    const before = stock();
    const out = treat();
    expect(out.ok && out.resultText).toContain("치료 값으로");
    expect(me().conditions.harm).toBe("none");
    expect(healer().inventory.bandage ?? 0).toBe(0);
    expect(stock()).toBe(before);
    // 거점: 무리 창고에서
    w.state().playerZone = "a_base";
    w.state().recovery.lastHealerDay = {};
    me().conditions.harm = "light";
    const out2 = treat();
    expect(out2.ok, out2.ok ? "" : out2.error).toBe(true);
    expect(stock()).toBe(before - 1);
  });

  it("주사위 눈의 한계: 2는 늘 실패, 3은 대가 있는 성공까지, 12는 적어도 대가 있는 성공", () => {
    expect(naturalLimit(2, "success")).toBe("miss");
    expect(naturalLimit(3, "success")).toBe("partial");
    expect(naturalLimit(12, "miss")).toBe("partial");
    expect(naturalLimit(12, "success")).toBe("success");
    expect(naturalLimit(7, "miss")).toBe("miss");
  });
});
