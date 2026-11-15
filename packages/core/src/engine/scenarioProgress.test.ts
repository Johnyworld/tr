import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { checkScenarioProgress } from "./scenarioProgress.ts";
import { roleOf, type GameEvent } from "../game/state.ts";

/** 시나리오 해금과 클리어 목표 (기획서 12.4.1) */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const choice = { name: "김서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function tutorial() {
  const dir = mkdtempSync(join(tmpdir(), "trpg-sp-"));
  const m = new WorldManager({ savesDir: dir, content, rngFactory: () => createSeededRng(5) });
  return { dir, m, w: m.create("mcp", "role_t_visitor", choice) };
}

describe("튜토리얼: 방문자", () => {
  it("고가도로에서 무소속으로 시작하고, 가족은 버들마을에 있다. 주인공은 이름만 알고 그 무리 사람들은 가족을 안다", () => {
    const { w } = tutorial();
    const st = w.state();
    expect(st.playerZone).toBe("overpass");
    expect(st.characters.player!.factionId).toBe("");
    expect(st.scenarioRole).toBe("role_t_visitor");
    expect(st.family.length).toBeGreaterThanOrEqual(2);
    for (const id of st.family) {
      const k = st.characters[id]!;
      expect(k.extra?.zone).toBe("b_base");
      expect(k.factionId).toBe("faction_b");
      expect(st.known.player).toContain(id);
      expect(st.known.b_dongcheol).toContain(id);
      expect(st.known.a_taeho ?? []).not.toContain(id);
      // 가족은 서로 아낀다 (거의 최상급)
      expect(st.relations[id]?.player).toMatchObject({ trust: 5, affection: 5, respect: 4 });
      expect(st.relations.player?.[id]).toMatchObject({ trust: 5, affection: 5, respect: 4 });
    }
    // 부모·형제자매·자식 중 적어도 한 사람은 주인공의 성을 따른다
    expect(st.family.some((id) => st.characters[id]!.name.startsWith("김"))).toBe(true);
    const facts = st.beliefs.player!.map((b) => b.fact).join(" / ");
    expect(facts).toContain("어디 있는지 모른다");
    expect(facts).not.toContain("버들마을");
    // GM 지침에 시나리오의 연출과 클리어 목표
    expect(w.guide()).toContain("## 시나리오: 튜토리얼: 방문자");
    expect(w.guide()).toContain("클리어 목표: 가족을 찾는다");
    w.close();
  });

  it("버들마을에 들어가기만 해서는 클리어가 아니다. 단서를 얻고 재회 이야기로 가족이 나타나면 클리어하고, 비극의 고리가 열린다 (모든 판에 남고, 알림은 닫을 때까지)", () => {
    const { dir, m, w } = tutorial();
    w.runCheat("~time +8h");
    const entered = w.runCheat("~goto b_base");
    expect(entered.ok && entered.text).not.toContain("시나리오 클리어");
    expect(w.state().cleared).toEqual([]);
    // 단서 없이 버들마을에 있으면 수소문 이야기가, 단서가 있으면 재회 이야기가 열린다
    w.ctx().store.append({ type: "flag_set", characterId: "player", flag: "tv_family_where" });
    const r = w.runCheat("~storylet tv_reunion");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const text = r.ok ? r.text : "";
    expect(w.state().scene.present.some((id) => w.state().family.includes(id))).toBe(true);
    expect(text).toContain("시나리오 클리어: 튜토리얼: 방문자");
    expect(text).toContain("end_session");
    // 튜토리얼이 끝나 "담 밖의 사람"도, 버들마을에 처음 들어갔을 때 "문을 지키는 사람"도 열렸다
    expect(text).toContain("시나리오 「비극의 고리」, 「담 밖의 사람」을 플레이할 수 있습니다");
    expect(w.state().cleared).toEqual(["role_t_visitor"]);
    expect(w.state().unlocked).toEqual(expect.arrayContaining(["role_a_grunt", "role_b_guard", "role_l_wanderer"]));
    expect(w.guide()).toContain("이미 이뤘다");
    expect(JSON.parse(readFileSync(join(dir, "unlocks.json"), "utf8")).post_apoc.sort()).toEqual(["role_a_grunt", "role_b_guard", "role_l_wanderer"]);
    expect(m.unlockNotices().map((n) => n.title).sort()).toEqual(["담 밖의 사람", "문을 지키는 사람", "비극의 고리"]);
    // 다시 오가도 또 클리어하지 않는다
    const again = w.runCheat("~goto old_town");
    expect(again.ok && again.text).not.toContain("시나리오 클리어");
    w.close();
  });

  it("가족 소식은 청솔에서 첫날을 보낸 뒤에, 가족 이야기는 GM 지침에 행방 없이", () => {
    const { w } = tutorial();
    const news = w.content.storylets.tv_family_news!;
    expect(news.when.flags_all).toContain("tv_settled");
    expect(news.when.zones).not.toContain("b_base");
    const section = w.guide().split("## 시나리오:")[1]!.split("\n## ")[0]!;
    expect(section).toContain("가족");
    expect(section).not.toContain("버들마을");
    w.close();
  });

  it("주인공이 죽어도 튜토리얼이 끝난 것으로 보고 비극의 고리가 열린다", () => {
    const { w } = tutorial();
    const died: GameEvent = {
      type: "character_died",
      record: { characterId: "player", name: "김서진", factionId: "", rank: "loner", startedAt: 0, diedAt: 60, merit: 0, cause: "감염체", deeds: [], epitaph: null },
    };
    const notices = checkScenarioProgress(w.ctx(), [died], "role_t_visitor");
    expect(notices).toEqual([
      { kind: "unlocked", roleId: "role_a_grunt", title: "비극의 고리" },
      { kind: "unlocked", roleId: "role_l_wanderer", title: "담 밖의 사람" },
    ]);
    w.close();
  });
});

describe("튜토리얼은 다음 캐릭터로 이어 갈 수 없다", () => {
  it("주인공이 죽으면 후보가 없고 이 판은 끝난다. 비극의 고리는 열린다. 다른 시나리오는 이어 갈 수 있다", () => {
    const { m, w } = tutorial();
    expect(w.runCheat("~kill me").ok).toBe(true);
    expect(w.isPlayerDead()).toBe(true);
    expect(w.storyEnded()).toBe(true);
    expect(w.successionOptions()).toEqual([]);
    const r = w.chooseNextCharacter("new");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("이 판은 주인공의 죽음으로 끝났다");
    expect(w.state().unlocked).toContain("role_a_grunt");
    const id = w.id;
    w.close();
    expect(m.listSlots().find((x) => x.id === id)?.hero).toMatchObject({ dead: true, ended: true });
    // 다른 시나리오는 그대로 이어 간다
    const grunt = m.create("mcp", "role_a_grunt", choice);
    grunt.runCheat("~kill me");
    expect(grunt.storyEnded()).toBe(false);
    expect(grunt.successionOptions().map((o) => o.id)).toContain("new:faction_a:grunt");
    grunt.close();
  });
});

describe("해금 조건", () => {
  it("붉은연합 사람에게 공격 판정을 하면 붉은 완장이 열린다. 다른 무리나 공격이 아닌 판정은 아니다", () => {
    const { w } = tutorial();
    const check = (move: string, target: string): GameEvent =>
      ({
        type: "check_rolled",
        checkId: "chk_t",
        turn: 1,
        actorId: "player",
        move,
        stat: "strength",
        difficulty: "normal",
        intent: "친다",
        dice: [3, 3],
        modifiers: { stat: 0, skill: 0, difficulty: 0, condition: 0, trait: 0, gear: 0 },
        total: 6,
        outcome: "miss",
        target,
      }) as GameEvent;
    expect(checkScenarioProgress(w.ctx(), [check("fight", "a_taeho"), check("persuade", "c_cheolgu")], "role_t_visitor")).toEqual([]);
    expect(checkScenarioProgress(w.ctx(), [check("fight", "c_cheolgu")], "role_t_visitor")).toEqual([{ kind: "unlocked", roleId: "role_c_comrades", title: "붉은 완장" }]);
    // 이미 열린 것은 다시 열지 않는다
    expect(checkScenarioProgress(w.ctx(), [check("shoot", "c_cheolgu")], "role_t_visitor")).toEqual([]);
    w.close();
  });

  it("비극의 고리로 시작하면 원수와 잃은 가족이 세계의 역사로 남는다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sp-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_a_grunt", choice);
    const st = w.state();
    expect(st.background.map((b) => b.part.kind)).toEqual(["loss", "enemy"]);
    expect(st.known.player).toContain("c_cheolgu");
    expect(st.beliefs.player!.map((b) => b.fact).join(" / ")).toContain("청솔형제단 순찰조가 나를 구했다");
    w.close();
  });

  it("붉은 완장으로 시작하면 일곱 동료가 주인공을 가깝게 여기고, 가장 친한 친구는 더 가깝다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sp-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_c_comrades", choice);
    const st = w.state();
    const bonds = content.roles.role_c_comrades!.start_bonds!;
    for (const id of bonds.ids) expect(st.relations[id]?.player?.trust ?? 0, id).toBeGreaterThanOrEqual(1);
    expect(st.relations[bonds.best!]!.player!.trust).toBeGreaterThanOrEqual(2);
    w.close();
  });
});

describe("두 번째 주인공부터는 세계만 이어 간다 (기획서 12.4.1)", () => {
  it("분대장 시나리오에서 분대원 NPC로 이어 가면 그 사람의 자리(분대원)를 받고, 시나리오와 분대 명령권은 따라오지 않는다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-sp-")), content, rngFactory: () => createSeededRng(5) });
    const w = m.create("mcp", "role_a_squad_leader", choice);
    w.runCheat("~kill me");
    const ids = w.successionOptions().map((o) => o.id);
    // 조우한 무리의 수색대원·분대장·간부, 이름을 아는 사람 (무리의 우두머리는 빠진다)
    expect(ids).toEqual(expect.arrayContaining(["new:faction_a:grunt", "new:faction_a:squad_leader", "new:faction_a:officer", "a_dongwook"]));
    expect(ids).not.toContain("a_seonghee");
    expect(w.chooseNextCharacter("a_dongwook").ok).toBe(true);
    const st = w.state();
    expect(st.playerId).toBe("a_dongwook");
    expect(st.scenarioRole).toBe("");
    expect(st.roleId).not.toBe("role_a_squad_leader");
    expect(roleOf(content, st)?.rank).toBe("grunt");
    expect(roleOf(content, st)?.squad ?? []).toEqual([]);
    expect(w.guide()).not.toContain("## 시나리오:");
    w.close();
  });
});

