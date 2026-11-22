import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeAccess } from "../game/culture.ts";
import { shelterAt } from "../rules/place.ts";
import { loadRealContent } from "../testing.ts";
import { personProfile } from "../views/person.ts";
import { WorldManager } from "../world/manager.ts";
import { rollPlayerCheck } from "./checks.ts";
import { describeImprovSlotForGm } from "./improvStory.ts";

/** 플레이 테스트 15 파트 8 (12-260): GM 부담·표시 */
const content = loadRealContent();
const choice = (name = "서진") => ({ name, gender: "female" as const, abilities: null, portrait: null, traits: [] });
const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-260-")), content, rngFactory: () => () => 0.5 });
const world = (roleId: string, name?: string) => manager().create("mcp", roleId, choice(name));

describe("도구 인자 (12-260)", () => {
  it("인자가 틀리면 그 도구의 인자 모양을 함께 알린다", () => {
    const w = world("role_a_grunt");
    const r = w.executeTool("stash", { action: "guard" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("이 도구(stash)의 인자");
    expect(!r.ok && r.error).toContain('"put"|"take"|"settle"');
    // 길면 한 단계만, 틀린 칸은 끝까지
    const t = w.executeTool("take_action", { intent: "행동", check: { move: "fight" } });
    expect(!t.ok && t.error).toContain("\ncheck: {");
  });
});

describe("판정 줄·설정 거스르기 (12-260)", () => {
  it("닥친 일에 버티는 판정은 줄에 까닭을 붙인다", () => {
    const w = world("role_a_grunt");
    const steady = content.scenario.body!.steady!;
    const r = rollPlayerCheck({ move: steady.move, stat: steady.stat, difficulty: "normal", intent: "마음을 다잡는다 (밤길)" }, w.ctx(), { reaction: true, purpose: "reaction" });
    expect(r.ok && r.display.line).toContain("· 마음을 다잡는다 (밤길):");
  });
});

describe("표시 (12-260)", () => {
  it("즉흥 이야기 자리는 곁에 사람이 없으면 한 줄만", () => {
    const w = world("role_y_islander");
    w.ctx().store.append({ type: "improv_slot_opened", expiresAt: w.state().time + 600 });
    const s = { ...w.state(), scene: { ...w.state().scene, present: [] }, companions: [] };
    const line = describeImprovSlotForGm(s, content);
    expect(line).toContain("곁에 사람이 없다");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("?인물에 내 비밀을 아는 사람이 보인다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const id = Object.keys(content.npcs).find((n) => s.characters[n])!;
    const me = { ...s.characters[s.playerId]!, settings: ["secret_deserter"] };
    const state = { ...s, characters: { ...s.characters, [s.playerId]: me }, secretKnownBy: { [s.playerId]: [id] } };
    expect(personProfile(state, content, id).knowsMySecret).toBe("탈영한 적이 있다");
    expect(personProfile(s, content, id).knowsMySecret).toBeNull();
  });

  it("배급·임무는 특권 줄에 보이지 않는다", () => {
    expect(describeAccess(content, "role_a_grunt")).toBe("");
    expect(describeAccess(content, "role_d_medic")).toContain("특권: 치료실");
  });
});

describe("겹치는 인물 이름 (12-260)", () => {
  it("주인공 이름이 월드 인물과 겹치면 그 인물을 대체 이름으로 바꾸고, 콘텐츠 글에도 반영한다", () => {
    const m = manager();
    const w = m.create("mcp", "role_a_officer", choice("도윤"));
    const npc = Object.values(content.npcs).find((n) => n.name === "한도윤")!;
    const swapped = w.state().nameSwaps[npc.id];
    expect(swapped?.from).toBe("한도윤");
    expect(swapped?.to).toMatch(/^한(태경|무진|서윤|소율)$/);
    expect(w.state().characters[npc.id]!.name).toBe(swapped!.to);
    expect(w.content.roles.role_a_officer!.opening_scene).not.toContain("한도윤");
    expect(w.content.roles.role_a_officer!.opening_scene).toContain(swapped!.to);
    const id = w.id;
    w.close();
    const again = m.open(id, "mcp");
    expect(again.content.npcs[npc.id]!.name).toBe(swapped!.to);
    again.close();
  });

  it("겹치지 않으면 그대로", () => {
    const w = world("role_a_officer", "서진");
    expect(w.state().nameSwaps).toEqual({});
    expect(w.content).toBe(content);
  });
});

describe("부르는 이야기·남의 거점 문 앞 (12-260)", () => {
  it("규율 회의는 다른 장소에 있어도 열리고 글의 장소로 불려 간다", () => {
    const w = world("role_c_raider");
    expect(w.state().playerPlace).toBe("barracks");
    w.runCheat("~storylet disc_c_council");
    expect(w.state().activeStorylet?.id).toBe("disc_c_council");
    expect(w.state().playerPlace).toBe("yard");
  });

  it("다른 무리 거점에 막 들어선 자리는 바깥이다", () => {
    const w = world("role_t_visitor");
    w.runCheat("~goto a_base");
    expect(w.state().playerPlace).toBeNull();
    expect(shelterAt(content, w.state(), "rest").indoor).toBe(false);
  });
});
