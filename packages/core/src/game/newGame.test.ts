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
import { answerNewGame, backNewGame, describeNewGameStep, newGameDraft, newGameStep, type NewGameDraft } from "./newGame.ts";

const REAL_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc");
const real = loadContent(REAL_DIR);

/** 두 번째 월드: 실제 팩을 복제해 id·이름·시나리오만 바꾼다 */
function secondWorld(): Content {
  const c = structuredClone(real);
  c.scenario.id = "second_world";
  c.scenario.world = { title: "얼어붙은 항구", tagline: "눈에 갇힌 항구 도시.", description: "배는 오지 않는다." };
  c.scenario.introText = "항구가 얼어붙은 지 세 해째.";
  const role = Object.values(c.roles)[0]!;
  c.roles = { harbor_scout: { ...role, id: "harbor_scout", history: [], background: [], scenario: { title: "항구의 정찰병", pitch: "얼음 위를 걷는다.", intro: "부두 창고에서 눈을 뜬다.", order: 0, heirs: true } } };
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

/** 캐릭터 만들기 끝까지 (과거 배경 경찰, 이름, 성별, 나이, 능력, 스킬, 트레잇, 시작) */
const CHARACTER = ["police", "서진", "female", "30", "random", "past", "none", "start"];

describe("새 게임: 월드 → 시나리오 → 캐릭터 → 수위 → 서술 방식 (기획서 4.2)", () => {
  it("월드 고르기는 이름·한 줄 소개·짧은 설명만, 고르면 그 월드의 시나리오 목록", () => {
    const world = describeNewGameStep(packs, newGameDraft());
    expect(world).toContain("무너진 도시 가람");
    expect(world).toContain("얼어붙은 항구");
    expect(world).toContain("눈에 갇힌 항구 도시.");
    const { draft } = run(["얼어붙은 항구"]);
    expect(newGameStep(draft)).toBe("scenario");
    const list = describeNewGameStep(packs, draft);
    expect(list).toContain("항구의 정찰병");
    expect(list).not.toContain("비극의 고리");
    // 고른 시나리오의 지금 상황은 캐릭터 만들기에서 묻지 않는다 (게임을 시작할 때 첫 장면 앞에서)
    expect(describeNewGameStep(packs, run(["second_world", "항구의 정찰병"]).draft)).not.toContain("부두 창고에서 눈을 뜬다.");
  });

  it("시나리오 목록: 튜토리얼이 맨 위, 잠긴 시나리오는 해금 조건과 함께 보이지만 고를 수 없다 (기획서 12.4.1)", () => {
    const { draft } = run(["post_apoc"]);
    const view = newGameView(packs, draft);
    expect(view.scenarios?.[0]).toMatchObject({ roleId: "role_t_visitor", title: "튜토리얼: 방문자", locked: null, goal: "가족을 찾는다", who: "무소속" });
    expect(view.scenarios?.map((c) => c.title)).toEqual(["튜토리얼: 방문자", "비극의 고리", "담 밖의 사람", "붉은 완장", "문을 지키는 사람", "흰 깃발", "여울섬의 새 식구", "짐마차의 길", "첫 번째 명령", "할당량"]);
    expect(view.scenarios?.slice(1).every((c) => c.locked)).toBe(true);
    // 목록에 없는 역할(간부 등)은 고를 수 없다
    expect(view.scenarios?.some((c) => c.roleId === "role_a_officer")).toBe(false);
    expect(answerNewGame(packs, draft, "role_a_officer", createSeededRng(1)).ok).toBe(false);
    const locked = answerNewGame(packs, draft, "비극의 고리", createSeededRng(1));
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toContain("튜토리얼을 마친다");
    expect(describeNewGameStep(packs, draft)).toContain("🔒 비극의 고리 (잠김)");
    // 해금되면 고를 수 있다
    const open = run(["post_apoc", "비극의 고리"], newGameDraft({ post_apoc: ["role_a_grunt"] })).draft;
    expect(open.roleId).toBe("role_a_grunt");
    expect(newGameStep(open)).toBe("character");
  });

  it("캐릭터를 다 만든 뒤 수위 → 서술 방식을 묻고 끝난다. 뒤로 가면 거꾸로 월드까지", () => {
    expect(answerNewGame(packs, newGameDraft(), "화성", createSeededRng(1)).ok).toBe(false);
    const made = run(["second_world", "harbor_scout", ...CHARACTER]).draft;
    expect(newGameStep(made)).toBe("content");
    expect(made.choice).toMatchObject({ name: "서진", gender: "female" });
    const content = run(["off"], made).draft;
    expect(newGameStep(content)).toBe("dialogue");
    const back = (n: number) => newGameStep(Array.from({ length: n }).reduce<NewGameDraft>((d) => backNewGame(d), content));
    expect([back(1), back(2)]).toEqual(["content", "character"]);
    // 캐릭터 확인 단계부터 하나씩 뒤로, 처음에서 시나리오, 월드
    const toScenario = Array.from({ length: 30 }).reduce<NewGameDraft>((d) => (newGameStep(d) === "scenario" ? d : backNewGame(d)), content);
    expect(newGameStep(toScenario)).toBe("scenario");
    expect(newGameStep(backNewGame(toScenario))).toBe("world");
  });

  it("끝까지 고르면 월드·시나리오·캐릭터·수위·서술 방식을 돌려준다", () => {
    const r = run(["second_world", "harbor_scout", ...CHARACTER, "on", "대본식"]);
    expect(r.done).toBe(true);
    if (r.done) expect(r).toMatchObject({ packId: "second_world", roleId: "harbor_scout", choice: { name: "서진", gender: "female" }, options: { mature: true, dialogue: "script" } });
  });

  it("계급 기본 훈련과 최소 나이: 분대장은 20세부터, 시나리오는 스킬을 주지 않고 과거 배경이 준다 (12-84, 12-87)", () => {
    const leader = run(["post_apoc", "첫 번째 명령", "doctor", "윤하", "female"], newGameDraft({ post_apoc: ["role_a_squad_leader"] })).draft;
    expect(answerNewGame(packs, leader, "27", createSeededRng(1)).ok).toBe(false); // 의사는 30세부터
    const done = run(["30", "past", "past", "none", "start", "off", "novel"], leader);
    if (!done.done) throw new Error("not done");
    expect(done.roleId).toBe("role_a_squad_leader");
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-role-")), content: real, rngFactory: () => createSeededRng(2) }).create("mcp", done.roleId, done.choice, done.packId);
    const me = w.state().characters[w.state().playerId]!;
    expect(me.skills).toMatchObject({ first_aid: 1, infected_lore: 1, shoot: -1, tactics: 1 }); // 과거 배경(의사) + 분대장 계급 기본 훈련(전략)
    expect(me.past).toMatchObject({ id: "doctor", label: "의사" });
    expect(w.state().beliefs[me.id]!.map((b) => b.fact).join()).toContain("붕괴 전에 나는 의사였다");
    w.close();
  });
});

describe("채팅과 상태 화면이 같은 것을 보여 준다", () => {
  const start = ["post_apoc", "role_t_visitor"];
  it("과거 배경의 물건은 이름으로 (id가 아니라)", () => {
    const text = describeNewGameStep(packs, run(start).draft);
    expect(text).toContain("쇠지렛대");
    expect(text).not.toContain("crowbar");
  });

  it("능력·스킬을 고치면 과거 배경의 배치를 보여 주고, 그 배치를 답 형식 그대로 넘기면 같은 값이 된다", () => {
    const abilities = run([...start, "soldier", "서진", "female", "30", "manual"]);
    const text = describeNewGameStep(packs, abilities.draft);
    expect(text).toContain("지금 배치 (과거 배경 군인): 민첩 +2");
    const asAnswer = /답 형식으로는 "([^"]+)"/.exec(text)![1]!;
    const view = newGameView(packs, abilities.draft);
    const next = run([asAnswer], abilities.draft);
    const set = next.draft.character.answers.at(-1);
    expect(set?.step === "ability_set" && Object.fromEntries(Object.entries(set.values).filter(([, v]) => v !== 0))).toEqual(view.character!.pastDefaults!.stats);
    // 스킬 고치기도 지금 고른 것부터
    const skills = run(["manual"], next.draft);
    expect(describeNewGameStep(packs, skills.draft)).toContain("지금 고른 것 (과거 배경 군인): 사격 +1, 전략 +1");
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
