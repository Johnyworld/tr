import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { chunkLore } from "./chunk.ts";
import type { SourceDoc } from "./index.ts";

/**
 * lore 적재 (기획서 11.4): content/scenarios/<id>/lore/*.md 를 읽어 청크로 나눈다.
 * 파일 해시를 함께 넘겨, 색인이 바뀐 파일만 다시 임베딩하게 한다.
 */
export function readLoreDocs(loreDir: string, maxChars?: number): SourceDoc[] {
  let names: string[];
  try {
    if (!statSync(loreDir).isDirectory()) return [];
    names = readdirSync(loreDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(loreDir, name), "utf8");
      const sourceId = `lore/${basename(name, ".md")}`;
      return { sourceId, hash: createHash("sha256").update(raw).digest("hex"), chunks: chunkLore(sourceId, raw, maxChars) };
    });
}
