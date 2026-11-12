/**
 * 검색 평가 CLI: pnpm rag:eval [옵션]
 *   --chunk 600        lore 청크 최대 글자 수
 *   --k 4              top-k
 *   --candidates 20    벡터·키워드 후보 수
 *   --weights 1:1      RRF 가중치 (벡터:키워드)
 *   --compare          여러 설정을 한 번에 비교
 *   --hash             bge-m3 대신 해시 임베더 (모델 없이 빠르게)
 *   --verbose          모든 사례의 결과 순위 출력
 * 실제 세이브와 lore 색인은 건드리지 않는다 (메모리 DB에 새로 만든다).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HashEmbedder, type Embedder } from "./embedder.ts";
import { DEFAULT_EVAL_CONFIG, formatEvalReport, loadRetrievalEval, runRetrievalEval, type RetrievalEvalConfig } from "./eval.ts";
import { BgeM3Embedder } from "./transformersEmbedder.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    chunk: { type: "string" },
    k: { type: "string" },
    candidates: { type: "string" },
    weights: { type: "string" },
    compare: { type: "boolean", default: false },
    hash: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

const scenarioDir = resolve(ROOT, `content/scenarios/${process.env.SCENARIO ?? "post_apoc"}`);
const data = loadRetrievalEval(scenarioDir);
const embedder: Embedder = values.hash ? new HashEmbedder(256) : new BgeM3Embedder({ cacheDir: resolve(ROOT, ".cache/models") });

const base: RetrievalEvalConfig = {
  chunkChars: Number(values.chunk ?? DEFAULT_EVAL_CONFIG.chunkChars),
  search: {
    ...DEFAULT_EVAL_CONFIG.search,
    ...(values.k ? { topK: Number(values.k) } : {}),
    ...(values.candidates ? { candidates: Number(values.candidates) } : {}),
    ...(values.weights ? { weights: { vector: Number(values.weights.split(":")[0]), keyword: Number(values.weights.split(":")[1]) } } : {}),
  },
};

if (values.compare) {
  const grid: [string, RetrievalEvalConfig][] = [
    ["기본", base],
    ["벡터만", { ...base, search: { ...base.search, weights: { vector: 1, keyword: 0 } } }],
    ["키워드만", { ...base, search: { ...base.search, weights: { vector: 0, keyword: 1 } } }],
    ["벡터 2:1", { ...base, search: { ...base.search, weights: { vector: 2, keyword: 1 } } }],
    ["청크 300자", { ...base, chunkChars: 300 }],
    ["청크 1200자", { ...base, chunkChars: 1200 }],
    ["top-2", { ...base, search: { ...base.search, topK: 2 } }],
    ["top-8", { ...base, search: { ...base.search, topK: 8, charBudget: 4800 } }],
  ];
  console.log(`임베더 ${embedder.id} · 사례 ${data.cases.length}개\n`);
  console.log("설정          recall@k   hit@1   MRR    위반");
  for (const [name, config] of grid) {
    const r = await runRetrievalEval(scenarioDir, data, embedder, config);
    console.log(`${name.padEnd(12)}  ${`${(r.recallAtK * 100).toFixed(0)}%`.padStart(7)}   ${`${(r.hitAt1 * 100).toFixed(0)}%`.padStart(5)}   ${r.mrr.toFixed(2)}   ${r.violations}`);
  }
} else {
  const report = await runRetrievalEval(scenarioDir, data, embedder, base);
  console.log(formatEvalReport(report, { verbose: values.verbose }));
  if (report.violations > 0) process.exit(1);
}
