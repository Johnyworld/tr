import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContentError, loadContent } from "../content/loader.ts";
import { loadContentPacks } from "../content/packs.ts";
import type { Content } from "../content/schemas.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";
import { newGameView } from "./newGameView.ts";
import { answerNewGame, backNewGame, describeNewGameStep, GAME_PREMISE, newGameDraft, newGameStep, setStoryStart, type NewGameDraft } from "./newGame.ts";

const REAL_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc");
const real = loadContent(REAL_DIR);

/** 두 번째 월드: 실제 팩을 복제해 id·이름·시나리오만 바꾼다 */
function secondWorld(): Content {
  const c = structuredClone(real);
  c.scenario.id = "second_world";
  c.scenario.world = { title: "얼어붙은 항구", tagline: "눈에 갇힌 항구 도시.", description: "배는 오지 않는다." };
  c.scenario.introText = "항구가 얼어붙은 지 세 해째.";
  const role = Object.values(c.roles)[0]!;
  c.roles = { harbor_scout: { ...role, id: "harbor_scout", scenario: { title: "항구의 정찰병", pitch: "얼음 위를 걷는다.", intro: "부두 창고에서 눈을 뜬다." } } };
  return c;
}

const packs = new Map<string, Content>([
  [real.scenario.id, real],
  ["second_world", secondWorld()],
]);

function run(answers: string[], draft: NewGameDraft = newGameDraft()) {
  const rng = createSeededRng(3);
  let d = draft;
  for (const a of answers) {
    const r = answerNewGame(packs, d, a, rng);
    if (!r.ok) throw new Error(`${a}: ${r.error}`);
    if (r.done) return r;
    d = r.draft;
  }
  return { ok: true as const, draft: d, done: false as const };
}

describe("새 게임: 월드 → 시나리오 → 캐릭터", () => {
  it("월드 고르기는 모든 월드의 이름·소개를 보여 주고, 고른 월드의 이야기와 시나리오로 이어진다", () => {
    const world = describeNewGameStep(packs, newGameDraft());
    expect(world).toContain("무너진 도시, 가람");
    expect(world).toContain("얼어붙은 항구");
    expect(world).toContain("눈에 갇힌 항구 도시.");
    // 죽음과 계승은 월드가 아니라 게임의 규칙: 월드가 몇 개든 한 번만
    expect(world.split(GAME_PREMISE)).toHaveLength(2);
    const { draft } = run(["얼어붙은 항구"]);
    expect(newGameStep(draft)).toBe("faction");
    const faction = describeNewGameStep(packs, draft);
    expect(faction).toContain("항구가 얼어붙은 지 세 해째.");
    expect(faction).toContain("떠돌이");
    const role = run(["second_world", "faction_a"]).draft;
    expect(newGameStep(role)).toBe("role");
    expect(describeNewGameStep(packs, role)).toContain("항구의 정찰병");
    expect(describeNewGameStep(packs, role)).not.toContain("청솔형제단의 수색대원");
    // 지금 상황은 동기 단계에서 먼저 (12-86)
    expect(describeNewGameStep(packs, run(["second_world", "항구의 정찰병"]).draft)).toContain("부두 창고에서 눈을 뜬다.");
    const first = describeNewGameStep(packs, run(["second_world", "항구의 정찰병", "skip", "off", "novel"]).draft);
    expect(first).not.toContain("부두 창고에서 눈을 뜬다.");
    expect(first).toContain("과거 배경");
  });

  it("모르는 월드·시나리오는 오류, 뒤로 가면 시나리오 → 무리 → 월드 순으로 되돌린다", () => {
    expect(answerNewGame(packs, newGameDraft(), "화성", createSeededRng(1)).ok).toBe(false);
    const { draft } = run(["second_world"]);
    expect(answerNewGame(packs, draft, "청솔형제단의 수색대원", createSeededRng(1)).ok).toBe(false); // 다른 월드의 시나리오
    const named = run(["second_world", "harbor_scout", "skip", "off", "novel", "police", "서진"]).draft;
    const back = (n: number) => newGameStep(Array.from({ length: n }).reduce<NewGameDraft>((d) => backNewGame(d), named));
    expect(back(2)).toBe("character"); // 과거 배경
    expect([back(3), back(4), back(5), back(6), back(7), back(8)]).toEqual(["dialogue", "content", "motive", "role", "faction", "world"]);
  });

  it("무리 → 계급(무리마다 부르는 이름, 그 자리의 시나리오) → 과거 배경이 스킬을 준다 (12-84)", () => {
    const red = run(["post_apoc", "faction_c"]).draft;
    const guide = describeNewGameStep(packs, red);
    for (const t of ["약탈조원: 붉은연합의 신입 약탈조원", "조장: 붉은연합의 약탈조장", "간부: 붉은연합의 위원"]) expect(guide).toContain(t);
    expect(guide).not.toContain("버들마을");
    expect(answerNewGame(packs, red, "role_b_guard", createSeededRng(1)).ok).toBe(false); // 다른 무리의 시나리오
    expect(answerNewGame(packs, red, "leader", createSeededRng(1)).ok).toBe(false);
    const raider = run(["약탈조원"], red).draft;
    expect(raider.roleId).toBe("role_c_raider");
    expect(newGameStep(raider)).toBe("motive"); // 준비된 시나리오도 동기와 이야기를 물을 수 있다 (건너뛸 수 있다, 12-86)
    // 다섯 무리 모두 분대원·분대장·간부로 시작할 수 있다
    for (const f of ["faction_a", "faction_b", "faction_c", "faction_d", "faction_e"]) {
      expect(newGameView(packs, run(["post_apoc", f]).draft).role?.presets.map((p) => p.rank)).toEqual(["grunt", "squad_leader", "officer"]);
    }
    // 시나리오는 스킬을 주지 않고, 과거 배경이 준다
    const done = run(["post_apoc", "faction_a", "squad_leader", "skip", "off", "novel", "doctor", "윤하", "female", "30", "past", "past", "none", "start"]);
    if (!done.done) throw new Error("not done");
    expect(done.roleId).toBe("role_a_squad_leader");
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-role-")), content: real, rngFactory: () => createSeededRng(2) }).create("mcp", done.roleId, done.choice, done.packId);
    const me = w.state().characters[w.state().playerId]!;
    expect(me.skills).toMatchObject({ first_aid: 1, infected_lore: 1, shoot: -1, tactics: 1 }); // 과거 배경(의사) + 분대장 계급 기본 훈련(전략), 시나리오는 스킬을 주지 않는다
    expect(me.stats).toMatchObject({ intellect: 2, strength: -1 });
    expect(me.past).toMatchObject({ id: "doctor", label: "의사" });
    expect(me.inventory.medkit).toBeGreaterThan(0);
    expect(w.state().beliefs[me.id]!.map((b) => b.fact).join()).toContain("붕괴 전에 나는 의사였다");
    w.close();
  });

  it("준비된 시나리오에도 동기와 이야기를 얹는다 (건너뛸 수 있다). 첫 장면은 시나리오 것, 상관·분대원·지도부는 원수로 둘 수 없다 (12-86)", () => {
    const written = run(["post_apoc", "faction_c", "squad_leader", "복수", "청솔형제단 정찰병이 형을 쏘았다."]).draft;
    expect(newGameStep(written)).toBe("story_setup");
    const guide = describeNewGameStep(packs, written);
    expect(guide).toContain("첫 장면(opening)은 넣지 않는다");
    expect(guide).toContain("마경수"); // 상관
    const enemy = (target: string) => ({ background: ["형의 마지막 숨을 기억한다."], history: [{ kind: "enemy" as const, target, why: "형을 쐈다", knows_you: false }] });
    expect(setStoryStart(packs, written, { ...enemy("faction_a"), opening: "새벽." }).ok).toBe(false); // 첫 장면은 시나리오 것
    for (const guarded of ["c_gyeongsu", "c_muyeol", "c_hyeran"]) {
      const r = setStoryStart(packs, written, enemy(guarded));
      expect(r.ok, guarded).toBe(false);
      if (!r.ok) expect(r.error).toContain("상관·분대원·지도부");
    }
    expect(setStoryStart(packs, written, { background: [], history: [{ kind: "deserter", faction: "faction_c" }] }).ok).toBe(false); // 지금 무리에서 도망쳐 나왔을 수는 없다
    const set = setStoryStart(packs, written, enemy("faction_a"));
    if (!set.ok) throw new Error(set.error);
    expect(describeNewGameStep(packs, set.draft)).not.toContain("첫 장면:");
    const done = run(["confirm", "off", "novel", "soldier", "윤하", "female", "30", "past", "past", "none", "start"], set.draft);
    if (!done.done) throw new Error("not done");
    expect(done.custom).toBeNull();
    expect(done.story).toMatchObject({ background: ["형의 마지막 숨을 기억한다."], motive: { id: "revenge" } });
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-story-")), content: real, rngFactory: () => createSeededRng(2) }).create("mcp", done.roleId, done.choice, done.packId, done.custom ?? undefined, done.options, done.story);
    const st = w.state();
    expect(st.characters[st.playerId]!.motive).toMatchObject({ id: "revenge" });
    expect(st.background.map((b) => b.part.kind)).toEqual(["enemy"]);
    expect(st.beliefs[st.playerId]!.map((b) => b.fact).join(" / ")).toContain("형의 마지막 숨");
    w.close();
    // 건너뛰면 바로 수위로
    expect(newGameStep(run(["post_apoc", "faction_c", "squad_leader", "skip"]).draft)).toBe("content");
  });

  it("계급 기본 훈련과 최소 나이: 간부는 25세부터, 의사는 30세부터. 과거 배경의 물건은 시나리오와 겹치지 않게 (12-87)", () => {
    const presets = newGameView(packs, run(["post_apoc", "faction_a"]).draft).role!.presets;
    expect(presets.map((p) => p.gains.split(" · ")[0])).toEqual(["사격 +1", "전략 +1", "교섭 +1"]);
    const officer = run(["post_apoc", "faction_a", "officer", "skip", "off", "novel", "police", "윤하", "female"]).draft;
    expect(describeNewGameStep(packs, officer)).toContain("25~65세");
    expect(answerNewGame(packs, officer, "24", createSeededRng(1)).ok).toBe(false);
    expect(answerNewGame(packs, officer, "25", createSeededRng(1)).ok).toBe(true);
    const doctor = run(["post_apoc", "faction_a", "officer", "skip", "off", "novel", "doctor", "윤하", "female"]).draft;
    expect(answerNewGame(packs, doctor, "27", createSeededRng(1)).ok).toBe(false); // 의사는 30세부터
    // 하얀매 수비대원은 구급상자를 갖고 시작한다: 의사 배경의 구급상자를 겹쳐 주지 않는다
    const done = run(["post_apoc", "faction_d", "grunt", "skip", "off", "novel", "doctor", "윤하", "female", "31", "past", "past", "none", "start"]);
    if (!done.done) throw new Error("not done");
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-rank-")), content: real, rngFactory: () => createSeededRng(2) }).create("mcp", done.roleId, done.choice, done.packId);
    const me = w.state().characters[w.state().playerId]!;
    expect(me.inventory.medkit).toBe(1);
    expect(me.skills).toMatchObject({ shoot: 1, first_aid: 1 }); // 분대원 계급 기본 훈련: 사격 +1
    w.close();
  });

  it("떠돌이는 계급도 직분도 없이 동행을 고르고, 스킬은 과거 배경에서 온다", () => {
    const loner = run(["post_apoc", "loner", "pet"]).draft;
    expect(newGameStep(loner)).toBe("motive");
    expect(loner.customRole).toMatchObject({ faction: "", rank: "loner", label: "떠돌이", start_skills: {} });
    expect(loner.customRole?.occupation).toBeUndefined();
    expect(loner.customRole?.start_inventory).toEqual(expect.arrayContaining(["blanket", "pipe_spear"]));
    expect(loner.built?.kin?.template).toBe("stray_dog");
    expect(newGameStep(backNewGame(loner))).toBe("companion"); // 역할 단계가 없어 동행으로
  });

  it("동기 → 이야기 → GM이 옮기기(코드 검증) → 확인, 이야기는 첫 장면과 세계의 역사로 남는다 (12-77)", () => {
    const setup = run(["post_apoc", "loner", "alone", "복수", "붉은연합이 우리 마을을 불태웠다. 어머니를 잃었다."]).draft;
    expect(newGameStep(setup)).toBe("story_setup");
    const guide = describeNewGameStep(packs, setup);
    expect(guide).toContain("어머니를 잃었다");
    expect(guide).toContain("loss, enemy");
    const story = {
      opening: "구시가의 무너진 상가. 불을 피우며 당신은 붉은 완장을 떠올린다.",
      background: ["붉은연합이 마을을 불태운 밤을 잊지 못한다."],
      history: [
        { kind: "loss" as const, who: "어머니", by: "faction_c", where: null },
        { kind: "enemy" as const, target: "faction_c", why: "마을을 불태웠다", knows_you: false },
      ],
    };
    expect(setStoryStart(packs, setup, { ...story, history: [{ kind: "enemy", target: "nobody", why: "x", knows_you: false }] }).ok).toBe(false);
    const set = setStoryStart(packs, setup, story);
    if (!set.ok) throw new Error(set.error);
    expect(newGameStep(set.draft)).toBe("story_confirm");
    expect(describeNewGameStep(packs, set.draft)).toContain("세계에 남는 지난 일");
    expect(newGameStep(run(["remap"], set.draft).draft)).toBe("story_setup");
    expect(newGameStep(run(["rewrite"], set.draft).draft)).toBe("story");
    const confirmed = run(["confirm"], set.draft).draft;
    expect(newGameStep(confirmed)).toBe("content");
    expect(confirmed.customRole?.opening_scene).toBe(story.opening);
    expect(backNewGame(backNewGame(confirmed)).customRole?.opening_scene).not.toBe(story.opening);
    const done = run(["off", "novel", "police", "윤하", "female", "30", "random", "past", "none", "start"], confirmed);
    expect(done.done).toBe(true);
    if (done.done) expect(done.custom).toMatchObject({ background: story.background, history: story.history, motive: { id: "revenge", label: "복수" } });
  });

  it("상태 화면은 [동기, 이야기]를 한 번에 보낸다. 다시 쓰기면 앞의 글이 남는다 (12-77)", () => {
    const base = run(["post_apoc", "loner", "alone"]).draft;
    const one = answerNewGame(packs, base, ["찾기", "동생을 찾는다."], createSeededRng(1));
    if (!one.ok) throw new Error(one.error);
    expect(newGameStep(one.draft)).toBe("story_setup");
    expect(one.draft.story).toMatchObject({ motive: "search", text: "동생을 찾는다." });
    expect(answerNewGame(packs, base, ["모험", "x"], createSeededRng(1)).ok).toBe(false);
    const set = setStoryStart(packs, one.draft, { opening: "구시가의 새벽.", background: [], history: [] });
    if (!set.ok) throw new Error(set.error);
    const rewrite = run(["rewrite"], set.draft).draft;
    expect(newGameStep(rewrite)).toBe("story");
    expect(rewrite.story).toMatchObject({ motive: "search", previous: "동생을 찾는다." });
    expect(newGameStep(run(["skip"], base).draft)).toBe("content");
  });

  it("끝까지 고르면 월드·시나리오·캐릭터를 돌려준다", () => {
    const r = run(["second_world", "harbor_scout", "skip", "off", "novel", "police", "서진", "female", "30", "random", "past", "none", "start"]);
    expect(r.done).toBe(true);
    if (r.done) expect(r).toMatchObject({ packId: "second_world", roleId: "harbor_scout", choice: { name: "서진", gender: "female" } });
  });
});

describe("월드가 여럿인 세이브", () => {
  it("고른 월드로 만들고, 목록에 월드 이름이 보이고, 열 때 그 월드로 연다. 모르는 월드의 세이브는 목록에 없다", () => {
    const savesDir = mkdtempSync(join(tmpdir(), "trpg-packs-"));
    const manager = new WorldManager({ savesDir, content: [...packs.values()], rngFactory: () => createSeededRng(1) });
    const w = manager.create("mcp", "harbor_scout", { name: "서진", gender: "female", abilities: null, portrait: null, traits: [] }, "second_world");
    const id = w.id;
    expect(w.content.scenario.id).toBe("second_world");
    w.close();
    expect(manager.listSlots()[0]).toMatchObject({ id, worldTitle: "얼어붙은 항구" });
    const reopened = manager.open(id, "mcp");
    expect(reopened.content.scenario.id).toBe("second_world");
    expect(reopened.state().roleId).toBe("harbor_scout");
    reopened.close();
    const only = new WorldManager({ savesDir, content: real });
    expect(only.listSlots()).toHaveLength(0);
    expect(() => only.open(id, "mcp")).toThrow("설치돼 있지 않다");
  });
});

describe("월드 팩 읽기", () => {
  function root() {
    const dir = mkdtempSync(join(tmpdir(), "trpg-root-"));
    cpSync(REAL_DIR, join(dir, "post_apoc"), { recursive: true });
    cpSync(REAL_DIR, join(dir, "harbor"), { recursive: true });
    const yaml = join(dir, "harbor", "scenario.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^id: post_apoc$/m, "id: harbor"));
    return dir;
  }

  it("scenario.yaml이 있는 폴더를 모두 읽고, only면 그것만", () => {
    const dir = root();
    expect(loadContentPacks(dir).map((c) => c.scenario.id)).toEqual(["harbor", "post_apoc"]);
    expect(loadContentPacks(dir, "harbor").map((c) => c.scenario.id)).toEqual(["harbor"]);
  }, 20_000); // 실제 월드 팩을 두 번 읽는다. 전체 테스트가 함께 돌면 5초를 넘기기도 한다

  it("폴더 이름과 id가 다르면 오류", () => {
    const dir = root();
    cpSync(REAL_DIR, join(dir, "wrong"), { recursive: true });
    expect(() => loadContentPacks(dir)).toThrow(ContentError);
  });
});
