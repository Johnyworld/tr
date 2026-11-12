import type { Rng } from "../rng.ts";
import type { Scenario } from "../scenario/schema.ts";

/**
 * 이름 생성 (기획서 7.5). 성 + 이름을 재료에서 고른다. 같은 세계에 이미 있는 이름은 피한다.
 * 순수 함수: (rng, 재료, 성별, 쓰인 이름) → 이름. 재료가 없으면 null
 */
export function generateName(
  rng: Rng,
  names: Scenario["names"],
  gender: string | null,
  used: ReadonlySet<string>,
): string | null {
  if (!names) return null;
  const pool = gender && names.given[gender] ? names.given[gender]! : Object.values(names.given).flat();
  if (pool.length === 0) return null;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  for (let i = 0; i < 50; i++) {
    const name = pick(names.surnames) + pick(pool);
    if (!used.has(name)) return name;
  }
  // 재료가 모자라 겹치면 끝에 구분 글자를 붙인다 (드문 경우)
  for (let n = 2; ; n++) {
    const name = `${pick(names.surnames)}${pick(pool)}${n}`;
    if (!used.has(name)) return name;
  }
}
