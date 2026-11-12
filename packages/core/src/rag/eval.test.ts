import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "./embedder.ts";
import { DEFAULT_EVAL_CONFIG, loadRetrievalEval, runRetrievalEval } from "./eval.ts";
import { DEFAULT_SEARCH } from "./index.ts";

const SCENARIO_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc");

/**
 * 검색 평가 세트 (기획서 11.4).
 * 단위 테스트는 해시 임베더(의미를 모른다)로 돌리므로 recall은 낮은 기준만 둔다.
 * 실제 모델 품질은 pnpm rag:eval 로 본다. 정보 필터 위반은 어떤 임베더·설정에서도 0건이어야 한다.
 */
describe("검색 평가 세트", () => {
  const data = loadRetrievalEval(SCENARIO_DIR);

  it("세트가 lore·memory 사례와 금지 사례를 모두 담고 있다", () => {
    expect(data.cases.some((c) => c.collection === "memory")).toBe(true);
    expect(data.cases.some((c) => c.collection === "lore")).toBe(true);
    expect(data.cases.filter((c) => c.forbid.length > 0).length).toBeGreaterThanOrEqual(5);
  });

  const configs = [
    DEFAULT_EVAL_CONFIG,
    { chunkChars: 200, search: { ...DEFAULT_SEARCH, topK: 10, charBudget: 100_000 } },
    { chunkChars: 1200, search: { ...DEFAULT_SEARCH, weights: { vector: 1, keyword: 0 } } },
    { chunkChars: 600, search: { ...DEFAULT_SEARCH, topK: 20, candidates: 50, charBudget: 100_000, weights: { vector: 0, keyword: 1 } } },
  ];

  it.each(configs.map((c, i) => [i, c] as const))("설정 %i: 정보 필터 위반 0건", async (_, config) => {
    const report = await runRetrievalEval(SCENARIO_DIR, data, new HashEmbedder(256), config);
    expect(report.cases.flatMap((c) => c.violations.map((v) => `${c.id}: ${v}`))).toEqual([]);
  });

  it("검사기 자체 확인: 볼 수 있는 것을 금지로 적으면 위반으로 잡는다", async () => {
    const broken = {
      ...data,
      cases: [{ id: "probe", query: "감염체 물결", viewer: "a_recruit", collection: "lore" as const, expect: [], forbid: ["lore/infected"] }],
    };
    const report = await runRetrievalEval(SCENARIO_DIR, broken, new HashEmbedder(256));
    expect(report.violations).toBeGreaterThan(0);
  });

  it("해시 임베더로도 기본 설정 recall@k가 기준 이상이다 (키워드 검색이 받쳐 준다)", async () => {
    const report = await runRetrievalEval(SCENARIO_DIR, data, new HashEmbedder(256));
    expect(report.recallAtK).toBeGreaterThanOrEqual(0.5);
  });
});
