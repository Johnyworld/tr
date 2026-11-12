/**
 * 명령어 출력 포매터 (기획서 11.7). 출력은 서버가 완성된 텍스트로 만든다 (고정폭 기준).
 */

export const GAUGE_FULL = "█"; // U+2588
export const GAUGE_EMPTY = "░"; // U+2591

/**
 * 게이지: 값을 비율로 환산해 반올림한다. 0이 아니면 최소 1칸. 대괄호 없음.
 * gauge(3, 8) → "███░░░░░"
 */
export function gauge(value: number, max: number, width = 8): string {
  if (max <= 0) return GAUGE_EMPTY.repeat(width);
  const ratio = Math.max(0, Math.min(1, value / max));
  let filled = Math.round(ratio * width);
  if (value > 0 && filled === 0) filled = 1;
  return GAUGE_FULL.repeat(filled) + GAUGE_EMPTY.repeat(width - filled);
}

/** "부상  ███░░░░░  경상" — 이름, 게이지, 상태 텍스트 (게이지 뒤 두 칸) */
export function gaugeLine(label: string, value: number, max: number, text: string, width = 8): string {
  return `${label}  ${gauge(value, max, width)}  ${text}`;
}

/** ━━━ 제목 ━━━ */
export function header(title: string): string {
  return `━━━ ${title} ━━━`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** 두 문자열의 편집 거리 (알 수 없는 명령어에 가장 가까운 것을 제안할 때) */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}
