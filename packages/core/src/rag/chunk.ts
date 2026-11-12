import { parse } from "yaml";
import { z } from "zod";

/**
 * lore 문서 청킹 (기획서 11.4).
 * - 파일 앞머리(front matter)에 제목과 공개 범위를 둔다
 * - `##` 절 단위로 나누고, 긴 절은 문단을 모아 MAX_CHUNK_CHARS 안팎으로 자른다
 * - 각 청크 앞에 "문서 제목 > 절 제목"을 붙여 검색 때 맥락을 잃지 않게 한다
 */

export const MAX_CHUNK_CHARS = 600;

/** 공개 범위: public | faction:<id> | secret:<flag> */
export const visibilitySchema = z.string().regex(/^(public|faction:[a-z][a-z0-9_]*|secret:[a-z][a-z0-9_]*)$/);

export const loreFrontMatterSchema = z.strictObject({
  title: z.string().min(1),
  visibility: visibilitySchema.default("public"),
  tags: z.array(z.string()).default([]),
});
export type LoreFrontMatter = z.infer<typeof loreFrontMatterSchema>;

export type LoreChunk = {
  /** <문서 id>#<번호> */
  id: string;
  sourceId: string;
  title: string;
  section: string;
  visibility: string;
  /** 검색·프롬프트에 쓰는 본문 (맥락 머리 포함) */
  text: string;
};

export class LoreFormatError extends Error {
  override name = "LoreFormatError";
}

/** "---\n<yaml>\n---\n본문" 형식을 나눈다 */
export function parseLoreFile(sourceId: string, raw: string): { meta: LoreFrontMatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new LoreFormatError(`${sourceId}: 앞머리(--- title, visibility ---)가 없다`);
  const meta = loreFrontMatterSchema.safeParse(parse(match[1]!));
  if (!meta.success) throw new LoreFormatError(`${sourceId}: ${z.prettifyError(meta.error)}`);
  // 작성자 메모(<!-- -->)는 검색 대상이 아니다
  return { meta: meta.data, body: match[2]!.replace(/<!--[\s\S]*?-->/g, "").trim() };
}

export function chunkLore(sourceId: string, raw: string, maxChars = MAX_CHUNK_CHARS): LoreChunk[] {
  const { meta, body } = parseLoreFile(sourceId, raw);
  const sections: { heading: string; text: string }[] = [];
  let current = { heading: "", text: "" };
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (current.text.trim()) sections.push(current);
      current = { heading: heading[1]!.trim(), text: "" };
    } else if (!/^#\s/.test(line)) {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) sections.push(current);

  const chunks: LoreChunk[] = [];
  for (const section of sections) {
    const paragraphs = section.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      const header = section.heading ? `${meta.title} > ${section.heading}` : meta.title;
      chunks.push({
        id: `${sourceId}#${chunks.length + 1}`,
        sourceId,
        title: meta.title,
        section: section.heading,
        visibility: meta.visibility,
        text: `[${header}]\n${buffer.join("\n\n")}`,
      });
      buffer = [];
    };
    for (const p of paragraphs) {
      if (buffer.length > 0 && buffer.join("\n\n").length + p.length > maxChars) flush();
      buffer.push(p);
    }
    flush();
  }
  return chunks;
}
