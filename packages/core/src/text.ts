/** 한국어 문장 도우미 */

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

/** 영문 대문자·숫자를 한국어로 읽을 때의 받침 (ㄱ 1, ㄴ 4, ㄹ 8, ㅁ 16, ㅇ 21). 없으면 0 ("세력 C가", "세력 L은") */
const LATIN_DIGIT_FINAL: Record<string, number> = {
  L: 8, M: 16, N: 4, R: 8,
  "0": 21, "1": 8, "3": 16, "6": 1, "7": 8, "8": 8,
};

/** 마지막 글자의 받침 번호 (0 = 받침 없음). 읽는 법을 모르는 글자면 null */
export function finalConsonant(word: string): number | null {
  const last = word.trim().at(-1);
  if (!last) return null;
  // 대문자·숫자만 읽는다 (소문자는 id 같은 것이라 읽는 법을 모른다)
  if (/^[A-Z0-9]$/.test(last)) return LATIN_DIGIT_FINAL[last] ?? 0;
  const code = last.charCodeAt(0);
  if (code < HANGUL_START || code > HANGUL_END) return null;
  return (code - HANGUL_START) % 28;
}

/**
 * 틀 문장을 채운다. "{name}"은 값으로, "{name:이/가}"는 값 + 맞는 조사로 바꾼다.
 * fill("{a:이/가} {z:을/를} 습격했다", { a: "세력 C", z: "동쪽 초소" }) → "세력 C가 동쪽 초소를 습격했다"
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z_]+)(?::([^}]+))?\}/g, (whole, key: string, pair?: string) => {
    const value = vars[key];
    if (value === undefined) return whole;
    return pair ? josa(String(value), pair as JosaPair) : String(value);
  });
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
