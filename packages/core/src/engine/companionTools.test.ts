import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { buildCustomRole, checkCustomStart, type CustomStartInput } from "../game/customStart.ts";
import { createSeededRng, type Rng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const act = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...extra });
const choice = { name: "도경", gender: "male" as const, abilities: null, portrait: null, traits: [] };

const loner: CustomStartInput = {
  faction: null,
  rank: "loner",
  title: "구시가의 떠돌이",
  location: "old_town",
  kit: "wanderer",
  skills: { scavenge: 1 },
  age: 33,
  opening: "아침, 무너진 상가 골목.",
  background: [],
};

function open(input: CustomStartInput = loner, rng: () => Rng = () => createSeededRng(5)) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-bonds-")), content, rngFactory: rng });
  return m.create("mcp", undefined, choice, undefined, { role: buildCustomRole(content, input), background: [] });
}
type World = ReturnType<typeof open>;

function cheat(w: World, input: string) {
  const r = w.runCheat(input);
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
}
function move(w: World, to: string) {
  const r = w.executeTool("take_action", act("간다", { move_to: to }));
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return r.ok ? r.resultText : "";
}
/** 이야기를 열고 고른다. 동행이 된 사람 id */
function joinBy(w: World, storylet: string, choiceId: string): string {
  cheat(w, `~storylet ${storylet}`);
  const r = w.executeTool("resolve_storylet", { choice_id: choiceId });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  return w.state().companions.at(-1)!;
}

describe("연고로 시작한다 (자유 시나리오)", () => {
  it("무소속이면 가족 하나를 데리고 시작한다. 서로 이름을 알고, 함께 다니는 이유는 연고다", () => {
    const w = open({ ...loner, kin: { template: "kin_young", label: "동생" } });
    const [kin] = w.state().companions;
    expect(kin).toBeTruthy();
    expect(w.state().bonds[kin!]?.kind).toBe("kin");
    expect(w.state().known.player).toContain(kin);
    expect(w.sceneForGm()).toContain("· 연고");
    w.close();
  });

  it("무리에 속해 시작하면 연고를 고르지 않고, 목록에 없는 틀은 안 된다", () => {
    expect(checkCustomStart(content, { ...loner, faction: "faction_a", rank: "grunt", location: "a_base", kin: { template: "kin_young", label: "동생" } }).join()).toContain("무소속으로 시작할 때만");
    expect(checkCustomStart(content, { ...loner, kin: { template: "drifter_leader", label: "대장" } }).join()).toContain("연고는");
    expect(checkCustomStart(content, { ...loner, kin: { template: "kin_elder", label: "아버지" } })).toEqual([]);
  });
});

describe("잠시 떨어짐 (기획서 7.9)", () => {
  it("이 구역에 남겨 두면 따라오지 않고, 다른 곳에서는 장면에 들일 수 없고, 돌아오면 저절로 합류한다", () => {
    const w = open({ ...loner, kin: { template: "kin_elder", label: "아버지" } });
    const [kin] = w.state().companions;
    expect(w.executeTool("companion_part", { target: kin, how: "wait", hours: null }).ok).toBe(true);
    move(w, "d_clinic");
    expect(w.state().scene.present).not.toContain(kin);
    expect(w.executeTool("npc_presence", { npc_id: kin, action: "enter" }).ok).toBe(false);
    expect(w.sceneForGm()).toContain("떨어져 있는 동행");
    const back = move(w, "old_town");
    expect(back).toContain("다시 합류했다");
    expect(w.state().companions).toContain(kin);
    expect(w.state().bonds[kin!]?.apart).toBeUndefined();
    w.close();
  });

  it("볼일을 보러 보내면 그 시간 뒤 돌아온다", () => {
    const w = open({ ...loner, kin: { template: "kin_sibling", label: "형" } });
    const [kin] = w.state().companions;
    expect(w.executeTool("companion_part", { target: kin, how: "errand", hours: 5 }).ok).toBe(true);
    expect(w.state().companions).not.toContain(kin);
    cheat(w, "~time +6h");
    expect(w.state().companions).toContain(kin);
    w.close();
  });

  it("이야기로 잠시 떨어진다 (하루만 다녀올게)", () => {
    const w = open({ ...loner, kin: { template: "kin_partner", label: "아내" } });
    const [kin] = w.state().companions;
    cheat(w, "~storylet wc_kin_errand");
    expect(w.executeTool("resolve_storylet", { choice_id: "let_go" }).ok).toBe(true);
    expect(w.state().bonds[kin!]?.apart?.until).toBeGreaterThan(w.state().time);
    w.close();
  });
});

describe("목적 동행과 갈림길", () => {
  it("하루만 같이 다니기로 하면 하루 뒤 갈림길이 온다. 보내면 헤어진다", () => {
    const w = open();
    const partner = joinBy(w, "wc_salvage_partner", "team");
    expect(w.state().bonds[partner]).toMatchObject({ kind: "purpose" });
    cheat(w, "~time +25h");
    expect(w.state().bonds[partner]?.crossroads?.lean).toBe("leave");
    expect(w.sceneForGm()).toContain("갈림길");
    expect(w.executeTool("companion_crossroads", { target: partner, choice: "let_go", move: null, stat: null }).ok).toBe(true);
    expect(w.state().companions).not.toContain(partner);
    expect(w.state().bonds[partner]).toBeUndefined();
    w.close();
  });

  it("사이가 가까우면 남고 싶어 하고, 붙잡으면 연고가 된다", () => {
    const w = open();
    const partner = joinBy(w, "wc_salvage_partner", "team");
    w.ctx().store.append({ type: "relation_changed", from: partner, to: "player", delta: { trust: 2, affection: 2, respect: 0 }, reason: "test" });
    cheat(w, "~time +25h");
    expect(w.state().bonds[partner]?.crossroads?.lean).toBe("stay");
    expect(w.executeTool("companion_crossroads", { target: partner, choice: "ask_stay", move: null, stat: null }).ok).toBe(true);
    expect(w.state().bonds[partner]?.kind).toBe("kin");
    w.close();
  });

  it("떠나려는 사람을 붙잡으면 판정한다. 대가 있는 성공이면 이틀 더, 정하지 않으면 그 사람 뜻대로", () => {
    const w = open(loner, () => () => 0.55); // 주사위 4+4
    const partner = joinBy(w, "wc_salvage_partner", "team");
    cheat(w, "~time +25h");
    const r = w.executeTool("companion_crossroads", { target: partner, choice: "ask_stay", move: "persuade", stat: "charm" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().bonds[partner]).toMatchObject({ kind: "purpose" });
    expect(w.state().bonds[partner]?.crossroads).toBeUndefined();

    const w2 = open();
    const p2 = joinBy(w2, "wc_salvage_partner", "team");
    cheat(w2, "~time +25h");
    cheat(w2, "~time +13h");
    expect(w2.state().companions).not.toContain(p2);
    w.close();
    w2.close();
  });

  it("진료소까지만: 그 구역에 닿으면 갈림길", () => {
    const w = open();
    const elder = joinBy(w, "wc_elder_to_clinic", "escort");
    expect(w.state().bonds[elder]?.until?.zone).toBe("d_clinic");
    const text = move(w, "d_clinic");
    expect(text).toContain("갈림길");
    w.close();
  });

  it("믿음이 바닥이면 떠난다. 연고는 더 버틴다. 동물은 떠나지 않는다", () => {
    const w = open({ ...loner, kin: { template: "kin_sibling", label: "형" } });
    const [kin] = w.state().companions;
    const partner = joinBy(w, "wc_salvage_partner", "team");
    const store = w.ctx().store;
    for (const id of [kin!, partner]) store.append({ type: "relation_changed", from: id, to: "player", delta: { trust: -2, affection: 0, respect: 0 }, reason: "test" });
    w.executeTool("take_action", act("둘러본다"));
    expect(w.state().companions).not.toContain(partner);
    expect(w.state().companions).toContain(kin);
    store.append({ type: "relation_changed", from: kin!, to: "player", delta: { trust: -1, affection: 0, respect: 0 }, reason: "test" });
    w.executeTool("take_action", act("둘러본다"));
    expect(w.state().companions).not.toContain(kin);
    w.close();
  });
});

describe("임무 짝 (2인 1조)", () => {
  function withOffer(roleId: string, template: string) {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-buddy-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", roleId, choice);
    const commander = w.content.roles[roleId]!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [template] });
    return { w, commander };
  }

  it("2인 1조 임무를 받으면 같은 계급의 동료가 짝으로 붙고, 보고하면 자기 자리로 돌아간다", () => {
    const { w } = withOffer("role_a_grunt", "front_recon");
    const day = Math.floor(w.state().time / 1440) + 1;
    expect(w.state().offers?.day).toBe(day);
    const r = w.executeTool("assign_mission", { template_id: "front_recon" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("2인 1조");
    const [buddy] = w.state().companions;
    expect(w.state().bonds[buddy!]).toMatchObject({ kind: "buddy" });
    expect(w.state().characters[buddy!]!.rank).toBe("grunt");
    const report = w.executeTool("report_mission", {});
    expect(report.ok && report.resultText).toContain("자기 자리로 돌아간다");
    expect(w.state().companions).not.toContain(buddy);
    w.close();
  });

  it("임무를 버려도 짝은 돌아가고, 짝이 없는 임무는 혼자 한다", () => {
    const { w } = withOffer("role_c_raider", "c_east_probe");
    expect(w.executeTool("assign_mission", { template_id: "c_east_probe" }).ok).toBe(true);
    expect(w.state().companions.length).toBe(1);
    w.executeTool("abandon_mission", { reason: "겁이 났다" });
    expect(w.state().companions).toEqual([]);
    const solo = withOffer("role_a_grunt", "wall_repair");
    expect(solo.w.executeTool("assign_mission", { template_id: "wall_repair" }).ok).toBe(true);
    expect(solo.w.state().companions).toEqual([]);
    w.close();
    solo.w.close();
  });
});
