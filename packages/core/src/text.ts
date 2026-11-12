/** 한국어 문장 도우미 */

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

/** 마지막 글자에 받침이 있는지. 한글이 아니면 null */
export function finalConsonant(word: string): number | null {
  const last = word.trim().at(-1);
  if (!last) return null;
  const code = last.charCodeAt(0);
  if (code < HANGUL_START || code > HANGUL_END) return null;
  return (code - HANGUL_START) % 28;
}

export type JosaPair = "이/가" | "은/는" | "을/를" | "과/와" | "으로/로";

/**
 * 받침에 맞는 조사를 붙인다. josa("강태호", "이/가") → "강태호가"
 * 한글로 끝나지 않으면 "단어이(가)"처럼 둘 다 적는다.
 */
export function josa(word: string, pair: JosaPair): string {
  const [withBatchim, without] = pair.split("/") as [string, string];
  const jong = finalConsonant(word);
  if (jong === null) {
    return pair === "으로/로" ? `${word}(으)로` : `${word}${withBatchim}(${without})`;
  }
  // "으로/로": 받침이 없거나 ㄹ 받침(8)이면 "로"
  if (pair === "으로/로") return `${word}${jong === 0 || jong === 8 ? without : withBatchim}`;
  return `${word}${jong === 0 ? without : withBatchim}`;
}

/** 문장 끝 마침표를 하나로 맞춘다 (요약에 이미 마침표가 있을 때 ".."이 되지 않게) */
export function sentence(text: string): string {
  return `${text.trim().replace(/[.。]+$/, "")}.`;
}
