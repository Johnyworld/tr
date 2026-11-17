import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContent } from "./packages/core/src/content/loader.ts";
import { REAL_CONTENT_DIR } from "./packages/core/src/testing.ts";

/**
 * 실제 월드 팩을 테스트 실행 전에 한 번만 읽고 검증해 JSON으로 적어 둔다.
 * 테스트는 loadRealContent()로 이것을 읽는다 (파일마다 YAML·zod를 다시 돌리지 않는다)
 */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trpg-test-content-"));
  const path = join(dir, "post_apoc.json");
  writeFileSync(path, JSON.stringify(loadContent(REAL_CONTENT_DIR)));
  process.env.TRPG_TEST_CONTENT = path;
  return () => rmSync(dir, { recursive: true, force: true });
}
