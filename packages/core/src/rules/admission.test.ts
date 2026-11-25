import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDailyBody } from "../engine/body.ts";
import { choiceAvailable, eligibleStorylets } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { admissionOf, chiefVisits, guestOf, intoOfferHours, offerDue, offeredPost, postFor } from "./admission.ts";
import { joinRole } from "../game/customStart.ts";
import { daysServed, serviceStart } from "../game/missions.ts";
import { rankName } from "../game/ranks.ts";
import { hostileLand } from "./home.ts";
import { welcomedAsGuest } from "./place.ts";
import { minuteOfDay } from "./time.ts";

/**
 * 공통 규칙 22 받아들임 (12-308, 사용자 결정): 무소속은 무리에 들 때 먼저 손님으로 지내고,
 * 2~5시간 뒤 7~20시 사이에 그 거점에서 우두머리가 면담해 권한다. 사양하면 3일 뒤에 다시
 */
const content = loadRealContent();
const make = (roleId: string, past?: string) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-adm-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [], ...(past ? { past } : {}) } as never);

const joinRoleFor = (faction: string, post: string) => joinRole(content, faction, "resident", { age: 30, occupation: post });

/** 튜토리얼 정문에서 손님으로 들어온 방문자 */
function admitted(past?: string) {
  const w = make("role_t_visitor", past);
  expect(w.runCheat("~goto a_base").ok).toBe(true);
  // 판정 없이 들어오는 길 (다시 찾아와 먹을 것을 내놓는다)
  expect(w.runCheat("~storylet tv_gate_again").ok).toBe(true);
  const r = w.executeTool("resolve_storylet", { choice_id: "offer_food" });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return w;
}

describe("받아들임 (공통 규칙 22)", () => {
  it("정문에서 받아 주면 손님이다: 무리·분대가 없고, 재워 준다", () => {
    const w = make("role_t_visitor");
    w.runCheat("~goto a_base");
    expect(w.runCheat("~storylet tv_gate").ok).toBe(true);
    const checked = w.executeTool("take_action", { intent: "솜씨를 보여 준다", check: { move: "survival", stat: "senses", difficulty: "normal", harm_on_failure: "none", harm_cause: "" }, activity: null, deed: null, target: null, narration_summary: null, for_mission: false });
    expect(checked.ok, checked.ok ? "" : checked.error).toBe(true);
    const r = w.executeTool("resolve_storylet", { choice_id: "show_skill" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const s = w.state();
    expect(s.flags[s.playerId] ?? []).toContain("tv_accepted"); // 고정 굴림 0.5: 받아 준다
    expect(s.characters[s.playerId]!.factionId).toBe("");
    expect(admissionOf(s)?.factionId).toBe("faction_a");
    expect(guestOf(s)).toBe("faction_a");
    expect(welcomedAsGuest(content, s)).toBe(true);
    expect(r.ok && r.resultText).toContain("손님으로 들었다");
    expect(r.ok && r.resultText).not.toContain("상관은");
  });

  it("면담은 2~5시간 뒤 7~20시 사이에만 열린다", () => {
    const w = admitted();
    const s = w.state();
    const a = admissionOf(s)!;
    expect(a).toBeTruthy();
    // 손님의 처지는 받아들임 줄 하나로 (무소속 줄 "배급이 없다"와 함께 나오지 않는다)
    expect(w.sceneForGm()).toContain("손님:");
    expect(w.sceneForGm()).not.toContain("상관·임무·배급이 없다");
    expect(a.offerAt - s.time).toBeGreaterThanOrEqual(2 * 60);
    const m = minuteOfDay(a.offerAt);
    expect(m >= 7 * 60 && m < 20 * 60).toBe(true);
    expect(offerDue(s, content, a.offerAt - 1)).toBe(false);
    expect(offerDue(s, content, a.offerAt)).toBe(true);
    expect(eligibleStorylets(s, content, a.offerAt).some((x) => x.id === "adm_offer")).toBe(true);
    // 밤에는 열지 않고 아침 7시로 미룬다
    const night = a.offerAt - minuteOfDay(a.offerAt) + 22 * 60;
    expect(offerDue(s, content, night)).toBe(false);
    expect(minuteOfDay(intoOfferHours(content, night))).toBe(7 * 60);
  });

  it("받아들이면 그때 들어간다 (적응 기간도)", () => {
    const w = admitted();
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    const r = w.executeTool("resolve_storylet", { choice_id: "accept" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const s = w.state();
    expect(s.characters[s.playerId]!.factionId).toBe("faction_a");
    expect(admissionOf(s)).toBeNull();
    expect(s.missionGraceUntil).toBeGreaterThan(s.time);
    expect(r.ok && r.resultText).toContain("적응 기간");
  });

  it("사양하면 손님으로 남고 3일 뒤에 다시 권한다", () => {
    const w = admitted();
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    expect(w.executeTool("resolve_storylet", { choice_id: "decline" }).ok).toBe(true);
    const s = w.state();
    const a = admissionOf(s)!;
    expect(s.characters[s.playerId]!.factionId).toBe("");
    expect(a.offers).toBe(1);
    expect(a.offerAt - s.time).toBeGreaterThanOrEqual(3 * 24 * 60);
    expect(guestOf(s)).toBe("faction_a");
  });

  it("손님은 묵는 거점에서 밤을 넘기면 그 무리의 끼니를 받는다 (지닌 먹을 것을 꺼내 먹지 않는다)", () => {
    const w = admitted();
    const s = w.state();
    const hunger = content.scenario.body!.hunger!.track;
    const before = { food: s.characters[s.playerId]!.inventory.dry_ration ?? 0, level: s.characters[s.playerId]!.conditions[hunger] };
    runDailyBody(w.ctx());
    const after = w.state().characters[s.playerId]!;
    expect(after.inventory.dry_ration ?? 0).toBe(before.food);
    expect(after.conditions[hunger]).toBe(before.level);
  });

  it("떠돌이를 먹잇감으로 보는 무리도 손님으로 들인 사람에게는 적 땅이 아니다", () => {
    const w = make("role_l_wanderer");
    expect(w.runCheat("~goto c_base").ok).toBe(true);
    const prey = content.scenario.helpless?.prey_on_strangers.includes("faction_c");
    if (prey) expect(hostileLand(w.state(), content, "c_base")).toBe(true);
    expect(w.runCheat("~storylet wl_red_toll").ok).toBe(true);
    expect(w.executeTool("resolve_storylet", { choice_id: "join_red" }).ok).toBe(true);
    expect(guestOf(w.state())).toBe("faction_c");
    expect(hostileLand(w.state(), content, "c_base")).toBe(false);
    expect(welcomedAsGuest(content, w.state())).toBe(true);
  });

  it("이미 무리에 있으면(옮기기) 손님을 거치지 않는다", () => {
    const w = make("role_b_guard");
    expect(w.runCheat("~storylet ws_pine_scout").ok).toBe(true);
    expect(w.state().activeStorylet?.id).toBe("ws_pine_scout");
    const choice = content.storylets.ws_pine_scout!.choices.find((c) => JSON.stringify(c).includes("join_faction"))!;
    expect(w.executeTool("resolve_storylet", { choice_id: choice.id }).ok).toBe(true);
    expect(w.state().characters[w.state().playerId]!.factionId).toBe("faction_a");
    expect(admissionOf(w.state())).toBeNull();
  });
});

/** 들어갈 자리 (12-309, 사용자 결정): 대표가 붕괴 전 직업을 보고 직분을 권하고, 수색대·수비대는 대신 청할 수 있다. 수색대원만 분대에 든다 */
describe("받아들임: 들어갈 자리", () => {
  const offer = (w: ReturnType<typeof make>, choice: string) => {
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    const r = w.executeTool("resolve_storylet", { choice_id: choice });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    return r.ok ? r.resultText : "";
  };
  const me = (w: ReturnType<typeof make>) => w.state().characters[w.state().playerId]!;
  const choices = (w: ReturnType<typeof make>) => {
    const s = w.state();
    return content.storylets.adm_offer!.choices.filter((c) => choiceAvailable(s, c, s.activeStorylet?.cast)).map((c) => c.id);
  };

  it("의사 출신은 의무실 자리를 권받고, 분대 없이 같은 일을 하는 사람 밑으로 들어간다", () => {
    const w = admitted("doctor");
    expect(offeredPost(w.state())).toBe("doctor");
    const text = offer(w, "accept");
    const p = me(w);
    expect(p.occupation?.id).toBe("doctor");
    expect(p.rank).toBe("resident");
    const role = w.state().customRole!;
    expect(role.squad ?? []).toEqual([]);
    // 청솔에는 주민보다 높은 의료인이 없어 간부 밑으로 간다 (분대장이 아니다)
    const chief = content.npcs[role.commander!]!;
    expect(role.commander).not.toBe(content.roles.role_a_grunt!.commander);
    expect(chief.rank).toBe("officer");
    expect(text).toContain("분대에는 들지 않는다");
  });

  it("같은 일을 하는 윗사람이 있으면 그 사람 밑으로 (하얀매의 간호사 → 수간호사)", () => {
    const role = joinRoleFor("faction_d", "nurse");
    const chief = content.npcs[role.commander!]!;
    expect(chief.occupation).toBe("nurse");
    expect(chief.rank).toBe("squad_leader");
    expect(role.squad ?? []).toEqual([]);
  });

  it("경찰 출신은 수색대를 권받고 지금처럼 분대장 밑 분대원이 된다", () => {
    const w = admitted("police");
    expect(offeredPost(w.state())).toBe("scavenger");
    const text = offer(w, "accept");
    expect(me(w).occupation?.id).toBe("scavenger");
    expect(me(w).rank).toBe("grunt");
    expect(w.state().customRole!.commander).toBe(content.roles.role_a_grunt!.commander);
    expect(text).not.toContain("분대에는 들지 않는다");
  });

  it("권한 자리와 같은 '청하기'는 보이지 않고, 수비대를 청하면 간부 밑 수비대원이 된다", () => {
    const w = admitted("police");
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    expect(choices(w)).toEqual(["accept", "ask_guard", "decline"]);
    const r = w.executeTool("resolve_storylet", { choice_id: "ask_guard" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(me(w).occupation?.id).toBe("guard");
    expect(me(w).rank).toBe("grunt");
    const chief = content.npcs[w.state().customRole!.commander!]!;
    expect(chief.faction).toBe("faction_a");
    expect(chief.rank).toBe("officer");
    expect(w.state().customRole!.label).toContain("수비대원");
  });

  it("이야기가 자리를 정해 두었으면 그것, 과거가 없으면 기본 자리(수비대)", () => {
    const w = make("role_t_visitor");
    expect(postFor(w.state(), content)).toBe("guard");
    expect(postFor(w.state(), content, "mechanic")).toBe("mechanic");
    const d = make("role_t_visitor", "doctor");
    expect(postFor(d.state(), content, "guard")).toBe("guard");
  });

  it("시작 지식은 같은 직분 시나리오에서만 받는다 (수비대원은 약탈조원의 '염철구를 통해'를 받지 않는다)", () => {
    const guard = joinRole(content, "faction_c", "grunt", { age: 30, occupation: "guard" });
    expect(guard.beliefs_preset).toBeUndefined();
    const scav = joinRole(content, "faction_c", "grunt", { age: 30, occupation: "scavenger" });
    expect(scav.beliefs_preset).toBeTruthy();
  });

  it("복무 일수는 무리에 든 날부터 센다", () => {
    const w = admitted("police");
    expect(w.runCheat("~time +2d").ok).toBe(true);
    const before = w.state();
    expect(Math.floor(before.time / (24 * 60))).toBeGreaterThan(Math.floor(before.runStartedAt / (24 * 60)));
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    expect(w.executeTool("resolve_storylet", { choice_id: "accept" }).ok).toBe(true);
    const s = w.state();
    expect(serviceStart(s)).toBe(s.time);
    expect(daysServed(s.time, serviceStart(s))).toBe(0);
  });

  it("상관은 거점에 사는 간부를 먼저 고른다 (나루상단: 정수장의 염덕수가 아니라 장터의 감태식)", () => {
    const role = joinRole(content, "faction_e", "grunt", { age: 30, occupation: "doctor" });
    expect(content.npcs[role.commander!]!.zone).toBe("e_market");
  });

  it("거점에 간부가 없으면 상관이 아침에 하루 한 번 거점에 들러 일감을 준다 (붉은연합)", () => {
    const w = make("role_l_wanderer", "police");
    expect(w.runCheat("~goto c_base").ok).toBe(true);
    expect(w.runCheat("~storylet wl_red_toll").ok).toBe(true);
    expect(w.executeTool("resolve_storylet", { choice_id: "join_red" }).ok).toBe(true);
    expect(w.runCheat("~storylet adm_offer").ok).toBe(true);
    expect(w.executeTool("resolve_storylet", { choice_id: "ask_guard" }).ok).toBe(true);
    const chief = w.state().customRole!.commander!;
    expect(content.npcs[chief]!.zone).not.toBe("c_base");
    // 다음 날 아침 8시로
    const s0 = w.state();
    const toMorning = ((24 * 60 - (s0.time % (24 * 60))) + 8 * 60) / 60;
    expect(w.runCheat(`~time +${Math.round(toMorning)}h`).ok).toBe(true);
    expect(chiefVisits(w.state(), content, chief)).toBe(true);
    expect(w.sceneForGm()).toContain("하루 한 번 들러 일감을 준다");
    const wait = { intent: "담 아래에서 기다린다", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false };
    w.executeTool("take_action", wait);
    // 그사이 열린 이야기는 두고 간다
    if (w.state().activeStorylet) w.executeTool("take_action", { ...wait, ignore_story: true });
    expect(chiefVisits(w.state(), content, chief)).toBe(true);
    const offer = w.state().offers?.templateIds[0];
    expect(offer).toBeTruthy();
    const r = w.executeTool("assign_mission", { template_id: offer! });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("건너와 거점에 들렀다");
    // 오늘은 다시 들르지 않는다
    expect(chiefVisits(w.state(), content, chief)).toBe(false);
  });

  it("분대에 들지 않는 자리는 무리의 계급 이름표(약탈조원)를 쓰지 않고, 수비대원은 보초·경비 일감만 빌린다 (12-312)", () => {
    expect(rankName(content, "faction_c", "grunt", "scavenger")).toBe("약탈조원");
    expect(rankName(content, "faction_c", "grunt", "guard")).toBe(content.scenario.rank_ladder.find((r) => r.id === "grunt")!.label);
    const guard = joinRole(content, "faction_c", "grunt", { age: 30, occupation: "guard" });
    expect(guard.missions.length).toBeGreaterThan(0);
    for (const id of guard.missions) expect(content.missions[id]!.requirements.some((r) => "activity" in r && r.activity === "guard_duty")).toBe(true);
    expect(guard.missions).not.toContain("c_east_probe");
  });

  it("손님일 때 ?상태 소속 줄은 손님으로 든 무리를 말한다", async () => {
    const w = admitted("nurse");
    expect(await w.runCommand("?상태")).toContain("청솔형제단의 손님");
  });
});

