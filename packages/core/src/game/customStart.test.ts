import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { buildCustomRole, checkCustomStart, joinRole, type CustomStartInput } from "./customStart.ts";
import { answerNewGame, describeNewGameStep, newGameDraft, newGameStep, setCustomStart, type NewGameDraft } from "./newGame.ts";
import { CUSTOM_ROLE_ID } from "./state.ts";

const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const packs = new Map<string, Content>([[content.scenario.id, content]]);

const base: CustomStartInput = {
  faction: "faction_a",
  rank: "officer",
  title: "청솔형제단 참모",
  location: "a_base",
  kit: "clerk",
  skills: { tactics: 1, persuade: 1 },
  age: 41,
  opening: "새벽, 지휘 천막. 당신은 밤새 그린 지도 위에서 고개를 든다.",
  background: ["붕괴 전에는 시청 도시계획과에서 일했다.", "첫 겨울에 아내를 잃었다."],
};

describe("자유 시나리오: 규칙", () => {
  it("간부·분대장은 되고, 한 자리뿐인 지도부는 안 된다", () => {
    expect(checkCustomStart(content, base)).toEqual([]);
    expect(checkCustomStart(content, { ...base, rank: "squad_leader" })).toEqual([]);
    expect(checkCustomStart(content, { ...base, rank: "leader" }).join()).toContain("지도부는 한 자리뿐");
  });

  it("세력에 속하면 그 세력의 구역에서, 무소속이면 정해진 계급·장소에서만 시작한다", () => {
    expect(checkCustomStart(content, { ...base, location: "c_base" }).join()).toContain("시작할 수 있는 곳");
    const free = { ...base, faction: null, rank: "loner", location: "old_town", title: "떠돌이 약초꾼" };
    expect(checkCustomStart(content, free)).toEqual([]);
    expect(checkCustomStart(content, { ...free, rank: "grunt" }).join()).toContain("무소속의 계급");
    expect(checkCustomStart(content, { ...free, location: "a_base" }).join()).toContain("무소속으로 시작할 수 있는 곳");
  });

  it("훈련 포인트·스킬 최대·나이·모르는 세력과 꾸러미는 오류", () => {
    expect(checkCustomStart(content, { ...base, skills: { tactics: 1, persuade: 1, shoot: 1 } }).join()).toContain("포인트를 넘었다");
    expect(checkCustomStart(content, { ...base, skills: { tactics: 2 } }).join()).toContain("0~1");
    expect(checkCustomStart(content, { ...base, age: 90 }).join()).toContain("나이");
    expect(checkCustomStart(content, { ...base, faction: "faction_z" }).join()).toContain("알 수 없는 세력");
    expect(checkCustomStart(content, { ...base, kit: "tank" }).join()).toContain("꾸러미");
  });
});

describe("자유 시나리오: 코드가 정하는 엔진 값", () => {
  it("상관은 같은 세력에서 바로 위 계급, 아는 사람은 같은 세력 모두, 임무는 같은 세력의 역할에서", () => {
    const officer = buildCustomRole(content, base);
    expect(officer).toMatchObject({ id: CUSTOM_ROLE_ID, faction: "faction_a", rank: "officer", commander: "a_seonghee", start_location: "a_base" });
    expect(officer.known_npcs).toContain("a_taeho");
    expect(officer.missions.length).toBeGreaterThan(0);
    expect(officer.beliefs_preset).toBe("a_officer"); // 같은 계급(참모) 시나리오의 시작 지식. 하급 전투원의 것은 주지 않는다
    expect(officer.start_inventory).toEqual(["ledger", "radio", "water_bottle", "canned_food"]);
    expect(buildCustomRole(content, { ...base, rank: "squad_leader" }).commander).toBe("a_doyun");
    const grunt = buildCustomRole(content, { ...base, rank: "grunt" });
    expect(grunt.commander).toBe("a_taeho");
    expect(grunt.beliefs_preset).toBe("a_grunt");
  });

  it("무소속은 상관·아는 사람·임무가 없다", () => {
    const loner = buildCustomRole(content, { ...base, faction: null, rank: "loner", location: "old_town" });
    expect(loner).toMatchObject({ faction: "", known_npcs: [], missions: [] });
    expect(loner.commander).toBeUndefined();
  });
});

function run(steps: (string | CustomStartInput)[]) {
  const rng = createSeededRng(4);
  let d: NewGameDraft = newGameDraft();
  for (const step of steps) {
    const r = typeof step === "string" ? answerNewGame(packs, d, step, rng) : setCustomStart(packs, d, step);
    if (!r.ok) throw new Error(`${JSON.stringify(step)}: ${r.error}`);
    if (r.done) return r;
    d = r.draft;
  }
  return { ok: true as const, done: false as const, draft: d };
}

describe("자유 시나리오: 새 게임 흐름", () => {
  it("직접 쓰기 → 글 → 옮기기(코드 검증) → 확인 → 캐릭터 만들기", () => {
    expect(describeNewGameStep(packs, run(["post_apoc"]).draft)).toContain("직접 만들기");
    const story = run(["post_apoc", "custom"]).draft;
    expect(newGameStep(story)).toBe("custom_story");
    const setup = run(["post_apoc", "custom", "나는 청솔형제단의 참모다. 마흔 하나."]).draft;
    expect(newGameStep(setup)).toBe("custom_setup");
    expect(describeNewGameStep(packs, setup)).toContain("나는 청솔형제단의 참모다");
    expect(setCustomStart(packs, setup, { ...base, rank: "leader" }).ok).toBe(false);
    const confirm = run(["post_apoc", "custom", "참모", base]).draft;
    expect(describeNewGameStep(packs, confirm)).toContain("상관: 최선희");
    const remap = run(["post_apoc", "custom", "참모", base, "remap"]).draft;
    expect(newGameStep(remap)).toBe("custom_setup");
    const name = run(["post_apoc", "custom", "참모", base, "confirm", "off"]).draft;
    expect(newGameStep(name)).toBe("character");
    expect(describeNewGameStep(packs, name)).toContain("지도 위에서 고개를 든다");
    const done = run(["post_apoc", "custom", "참모", base, "confirm", "off", "한서진", "female", "random", "none", "start"]);
    expect(done.done).toBe(true);
    if (done.done) expect(done.custom).toMatchObject({ role: { id: "custom", rank: "officer" }, background: base.background });
  });
});

describe("자유 시나리오: 세계", () => {
  const manager = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-custom-")), content, rngFactory: () => createSeededRng(2) });
  const choice = { name: "한서진", gender: "female", abilities: null, portrait: null, traits: [] };

  it("그 역할로 시작하고, 다시 열어도 역할이 남는다. 지난 삶은 주인공의 기억", () => {
    const m = manager();
    const w = m.create("mcp", undefined, choice, undefined, { role: buildCustomRole(content, base), background: base.background });
    const state = w.state();
    expect(state.roleId).toBe("custom");
    expect(state.characters.player).toMatchObject({ factionId: "faction_a", rank: "officer", age: 41, skills: expect.objectContaining({ tactics: 1 }) });
    expect(state.playerZone).toBe("a_base");
    expect(state.beliefs.player!.map((b) => b.fact)).toContain("첫 겨울에 아내를 잃었다.");
    expect(w.guide()).toContain("지도 위에서 고개를 든다");
    const id = w.id;
    w.close();
    const again = m.open(id, "mcp");
    expect(again.content.roles.custom?.label).toBe("청솔형제단 참모");
    again.close();
  });

  it("무소속으로 며칠을 지내도 멈추지 않는다", () => {
    const m = manager();
    const loner = { ...base, faction: null, rank: "loner", location: "riverside", title: "떠돌이 약초꾼", kit: "wanderer" };
    const w = m.create("mcp", undefined, choice, undefined, { role: buildCustomRole(content, loner), background: [] });
    for (let i = 0; i < 4; i++) {
      const r = w.executeTool("take_action", { intent: "잔다", check: null, activity: { kind: "sleep", until: "morning" }, deed: null, target: null, narration_summary: null, for_mission: false });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect(w.state().characters.player!.factionId).toBe("");
    expect(w.state().playerZone).toBe("riverside");
    w.close();
  });

  it("사망 뒤 새 캐릭터도 같은 자유 시나리오 역할로 이어 간다", () => {
    const m = manager();
    const w = m.create("mcp", undefined, choice, undefined, { role: buildCustomRole(content, base), background: [] });
    w.runCheat("~kill me");
    const r = w.chooseNextCharacter("new", null, { ...choice, name: "윤하" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const heir = w.state().characters[w.state().playerId]!;
    expect(heir).toMatchObject({ name: "윤하", rank: "officer", factionId: "faction_a" });
    w.close();
  });
});

describe("자유 시나리오: 다른 세력의 같은 계급", () => {
  it("다른 세력으로 쓴 분대장은 청솔형제단 분대장 시나리오의 임무·태그를 빌리지 않는다", () => {
    const red = buildCustomRole(content, { ...base, faction: "faction_c", rank: "squad_leader", location: "c_base" });
    const pineSquad = content.roles.role_a_squad_leader;
    expect(pineSquad).toBeDefined();
    expect(red.storylet_tags).not.toContain("a_squad_leader");
    expect(red.missions.some((m) => pineSquad!.missions.includes(m))).toBe(false);
    expect(buildCustomRole(content, { ...base, rank: "squad_leader" }).storylet_tags).toContain("a_squad_leader");
  });
});

describe("무소속이 무리에 들어간다 (join_faction)", () => {
  it("가장 낮은 계급으로 들어가 상관·동료·임무·배급이 생긴다", async () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-join-")), content, rngFactory: () => createSeededRng(2) });
    const loner = { ...base, faction: null, rank: "loner", location: "old_town", title: "떠돌이", kit: "wanderer" };
    const w = m.create("mcp", undefined, { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, undefined, { role: buildCustomRole(content, loner), background: [] });
    const role = joinRole(content, "faction_b", undefined, { age: 30 });
    expect(role).toMatchObject({ faction: "faction_b", rank: "grunt", commander: "b_dongcheol" });
    w.ctx().store.append({ type: "player_joined_faction", factionId: "faction_b", rank: role.rank, role, beliefs: [] });
    const s = w.state();
    expect(s.characters.player).toMatchObject({ factionId: "faction_b", rank: "grunt" });
    expect(s.known.player).toContain("b_dongcheol");
    expect(w.content.roles.custom?.commander).toBe("b_dongcheol");
    expect(await w.runCommand("?상태")).toContain("상관 배동철");
    w.executeTool("take_action", { intent: "잔다", check: null, activity: { kind: "sleep", until: "morning" }, deed: null, target: null, narration_summary: null, for_mission: false });
    expect(w.sceneForGm()).toContain("오늘 받을 수 있는 임무");
    expect(await w.runCommand("?배급")).toContain("오늘 배급");
    w.close();
  });
});

describe("스카우트: 뛰어난 조직원이 다른 무리로 옮긴다", () => {
  it("공적 9 이상이면 다른 무리의 스카우트가 열리고, 받아들이면 옮겨 간다 (옛 상관 신뢰↓, 새 상관, 같은 계급의 시작 지식)", async () => {
    const { eligibleStorylets } = await import("../story/storylets.ts");
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-scout-")), content, rngFactory: () => createSeededRng(2) });
    const w = m.create("mcp", "role_b_guard", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] });
    const s = w.state();
    const evening = s.time + 6 * 24 * 60 + 6 * 60; // 엿새 뒤 한낮
    let merit = 0;
    const scouts = () => {
      const st = w.state();
      const withMerit = { ...st, characters: { ...st.characters, player: { ...st.characters.player!, merit } } };
      return eligibleStorylets(withMerit, w.content, evening).map((x) => x.id).filter((id) => id.startsWith("ws_"));
    };
    expect(scouts()).toEqual([]);
    merit = 9;
    expect(scouts()).toContain("ws_pine_scout"); // 버들마을 사람에게 청솔형제단이 손을 내민다
    // 청솔형제단으로 옮기는 효과를 그대로 적용한다
    const role = joinRole(content, "faction_a", "squad_leader", { age: 30, title: "청솔형제단 분대장" });
    w.ctx().store.append({ type: "player_joined_faction", factionId: "faction_a", rank: role.rank, role, beliefs: [] });
    expect(w.state().characters.player).toMatchObject({ factionId: "faction_a", rank: "squad_leader" });
    expect(w.content.roles.custom?.commander).toBe("a_doyun");
    expect(w.content.roles.custom?.storylet_tags).toContain("a_squad_leader");
    expect(scouts()).not.toContain("ws_pine_scout");
    w.close();
  });
});
