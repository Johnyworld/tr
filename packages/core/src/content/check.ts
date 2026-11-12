/**
 * 콘텐츠 검증 CLI: pnpm content:check
 * 사용법: tsx src/content/check.ts [시나리오 폴더]
 */
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ContentError, loadContent } from "./loader.ts";
import { loadRetrievalEval, RetrievalEvalError } from "../rag/eval.ts";

const dir = resolve(process.argv[2] ?? "content/scenarios/post_apoc");
try {
  const content = loadContent(dir);
  const { scenario, ...kinds } = content;
  const counts = Object.entries(kinds).map(([kind, entries]) => `${kind} ${Object.keys(entries).length}`);
  console.log(`콘텐츠 검증 통과 (${scenario.id}, ${dir}): ${counts.join(", ")}`);
  if (existsSync(join(dir, "eval", "retrieval.yaml"))) {
    const evalSet = loadRetrievalEval(dir);
    console.log(`검색 평가 세트 통과: 사례 ${evalSet.cases.length}개, 합성 기억 ${evalSet.memory.length}개`);
  }
} catch (err) {
  if (err instanceof ContentError || err instanceof RetrievalEvalError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
