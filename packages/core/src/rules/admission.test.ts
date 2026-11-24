import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDailyBody } from "../engine/body.ts";
import { eligibleStorylets } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { admissionOf, guestOf, intoOfferHours, offerDue } from "./admission.ts";
import { hostileLand } from "./home.ts";
import { welcomedAsGuest } from "./place.ts";
import { minuteOfDay } from "./time.ts";

/**
 * 공통 규칙 22 받아들임 (12-308, 사용자 결정): 무소속은 무리에 들 때 먼저 손님으로 지내고,
 * 2~5시간 뒤 7~20시 사이에 그 거점에서 우두머리가 면담해 권한다. 사양하면 3일 뒤에 다시
 */
const content = loadRealContent();
const make = (roleId: string) =>
  new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-adm-")), content, rngFactory: () => () => 0.5 }).create("mcp", roleId, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] } as never);

/** 튜토리얼 정문에서 손님으로 들어온 방문자 */
function admitted() {
  const w = make("role_t_visitor");
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
