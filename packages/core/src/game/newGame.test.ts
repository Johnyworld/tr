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
    const { draft } = run(["얼어붙은 항구"]);
    expect(newGameStep(draft)).toBe("scenario");
    const scenario = describeNewGameStep(packs, draft);
    expect(scenario).toContain("항구가 얼어붙은 지 세 해째.");
    expect(scenario).toContain("항구의 정찰병");
    expect(scenario).not.toContain("청솔형제단의 하급 전투원");
    const name = describeNewGameStep(packs, run(["second_world", "항구의 정찰병"]).draft);
    expect(name).toContain("부두 창고에서 눈을 뜬다.");
    expect(name).toContain("이름");
  });

  it("모르는 월드·시나리오는 오류, 뒤로 가면 시나리오 → 월드 순으로 되돌린다", () => {
    expect(answerNewGame(packs, newGameDraft(), "화성", createSeededRng(1)).ok).toBe(false);
    const { draft } = run(["second_world"]);
    expect(answerNewGame(packs, draft, "청솔형제단의 하급 전투원", createSeededRng(1)).ok).toBe(false); // 다른 월드의 시나리오
    const named = run(["second_world", "harbor_scout", "서진"]).draft;
    expect(newGameStep(backNewGame(backNewGame(named)))).toBe("scenario");
    expect(newGameStep(backNewGame(backNewGame(backNewGame(named))))).toBe("world");
  });

  it("끝까지 고르면 월드·시나리오·캐릭터를 돌려준다", () => {
    const r = run(["second_world", "harbor_scout", "서진", "female", "random", "none", "start"]);
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
  });

  it("폴더 이름과 id가 다르면 오류", () => {
    const dir = root();
    cpSync(REAL_DIR, join(dir, "wrong"), { recursive: true });
    expect(() => loadContentPacks(dir)).toThrow(ContentError);
  });
});
