/**
 * 콘텐츠 검증 CLI: pnpm content:check
 * 사용법: tsx src/content/check.ts [시나리오 폴더]
 */
import { resolve } from "node:path";
import { ContentError, loadContent } from "./loader.ts";

const dir = resolve(process.argv[2] ?? "content/scenarios/post_apoc");
try {
  const content = loadContent(dir);
  const { scenario, ...kinds } = content;
  const counts = Object.entries(kinds).map(([kind, entries]) => `${kind} ${Object.keys(entries).length}`);
  console.log(`콘텐츠 검증 통과 (${scenario.id}, ${dir}): ${counts.join(", ")}`);
} catch (err) {
  if (err instanceof ContentError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
