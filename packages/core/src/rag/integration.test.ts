import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestWorld } from "../testing.ts";
import { InMemoryRepository } from "../persistence/repository.ts";
import { createSeededRng } from "../rng.ts";
import { HashEmbedder } from "./embedder.ts";
import { RagIndex } from "./index.ts";
import { LoreLibrary } from "./library.ts";
import { readLoreDocs } from "./lore.ts";

const LORE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc/lore");

async function realLore() {
  const index = RagIndex.open(":memory:", new HashEmbedder(256));
  await index.sync(readLoreDocs(LORE_DIR));
  return LoreLibrary.fromIndex(index);
}

describe("lore 검색과 정보 필터 (실제 lore)", () => {
  it("세력 A 캐릭터에게는 C 내부 사정과 비밀 문서가 어떤 검색어로도 나오지 않는다", async () => {
    const lore = await realLore();
    const viewer = { factionId: "faction_a", flags: new Set<string>() };
    const queries = [
      "세력 C 병사들은 지도부를 두려워한다",
      "C의 동쪽 공세 계획",
      "실종된 정찰조는 어디에 갇혀 있나",
      "고가도로 너머 물류창고 수용소",
      "정찰조 포로 교환",
    ];
    for (const q of queries) {
      const { hits, trace } = await lore.search(q, viewer, { topK: 10, charBudget: 100_000 });
      for (const h of hits) expect(["lore/faction_c_inside", "lore/secret_scouts"], q).not.toContain(h.sourceId);
      expect(JSON.stringify(trace)).not.toMatch(/faction_c_inside|secret_scouts/);
    }
  });

  it("A 캐릭터는 A 내부 문서를 찾는다", async () => {
    const lore = await realLore();
    const { hits } = await lore.search("거점 배급 규칙", { factionId: "faction_a", flags: new Set() });
    expect(hits.some((h) => h.sourceId === "lore/faction_a")).toBe(true);
  });
});

describe("GameWorld.searchLore", () => {
  it("검색 기록을 남기되 게임 상태는 바꾸지 않는다", async () => {
    const repo = new InMemoryRepository();
    const world = createTestWorld("web", createSeededRng(1), repo);
    // createTestWorld는 lore 없이 만들므로 lore를 붙인 세계를 따로 연다
    const { GameWorld } = await import("../world/world.ts");
    const withLore = new GameWorld({ content: world.content, repo, mode: "web", rng: createSeededRng(1), lore: await realLore() });
    const before = JSON.stringify(withLore.state());
    const result = await withLore.searchLore("감염체 물결 고가도로", "gm_context");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(withLore.state())).toBe(before);
    expect(withLore.retrievals()).toMatchObject([{ collection: "lore", purpose: "gm_context", mode: "web" }]);
  });

  it("lore가 없으면 빈 결과와 이유를 돌려준다 (게임은 계속된다)", async () => {
    const world = createTestWorld("web");
    expect(await world.searchLore("아무거나", "recall")).toMatchObject({ hits: [], error: expect.any(String) });
  });

  it("색인 준비가 실패해도 검색이 예외를 던지지 않는다", async () => {
    const broken = new LoreLibrary(Promise.reject(new Error("모델 없음")));
    expect(await broken.search("x", { factionId: "a", flags: new Set() })).toMatchObject({ hits: [], error: expect.stringContaining("모델 없음") });
  });
});
