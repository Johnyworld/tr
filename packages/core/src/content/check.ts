/**
 * 콘텐츠 검증 CLI: pnpm content:check
 * 사용법: tsx src/content/check.ts [월드 팩 폴더]. 폴더를 주지 않으면 content/scenarios/ 아래 월드 팩을 모두 검사한다
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContentError, loadContent } from "./loader.ts";
import { loadContentPacks } from "./packs.ts";
import { loadRetrievalEval, RetrievalEvalError } from "../rag/eval.ts";
import type { Content } from "./schemas.ts";

const root = resolve(import.meta.dirname, "../../../../content/scenarios");
try {
  const packs: { content: Content; dir: string }[] = process.argv[2]
    ? [{ content: loadContent(resolve(process.argv[2])), dir: resolve(process.argv[2]) }]
    : loadContentPacks(root).map((content) => ({ content, dir: join(root, content.scenario.id) }));
  for (const { content, dir } of packs) {
    const { scenario, ...kinds } = content;
    const counts = Object.entries(kinds).map(([kind, entries]) => `${kind} ${Object.keys(entries).length}`);
    console.log(`콘텐츠 검증 통과 (${scenario.id}, ${dir}): ${counts.join(", ")}`);
    if (!scenario.world) console.log(`  참고: ${scenario.id}에 world(월드 고르기 소개)가 없다`);
    for (const role of Object.values(content.roles)) {
      if (!role.scenario) console.log(`  참고: ${scenario.id}/${role.id}에 scenario(시나리오 고르기 소개)가 없다`);
    }
    if (existsSync(join(dir, "eval", "retrieval.yaml"))) {
      const evalSet = loadRetrievalEval(dir);
      console.log(`검색 평가 세트 통과: 사례 ${evalSet.cases.length}개, 합성 기억 ${evalSet.memory.length}개`);
    }
  }
} catch (err) {
  if (err instanceof ContentError || err instanceof RetrievalEvalError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
