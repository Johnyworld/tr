/**
 * 공통 규칙 5: 같은 것은 쉰다 (docs/design.md "공통 규칙").
 *
 * 최근에 나온 배역·일감·경보 이야기는 다른 후보가 있는 한 쉰다. 며칠 쉬는지는 시나리오의 rest에 둔다 (원칙 7).
 * 새로 쉬게 할 것이 생기면 REST_KINDS에 이름을 더하고 시나리오에 날수를 적는다.
 */
import type { Content } from "../content/schemas.ts";
import { MINUTES_PER_DAY } from "./time.ts";

export const REST_KINDS = ["cast", "mission", "alarm"] as const;
export type RestKind = (typeof REST_KINDS)[number];

/** 이 종류가 쉬는 날수 (시나리오에 없으면 0: 쉬지 않는다) */
export function restDays(content: Pick<Content, "scenario">, kind: RestKind): number {
  return content.scenario.rest?.[kind] ?? 0;
}

/** 마지막으로 나온 때(lastAt)에서 아직 쉬는 중인가 */
export function resting(content: Pick<Content, "scenario">, kind: RestKind, lastAt: number | null | undefined, now: number): boolean {
  if (lastAt === null || lastAt === undefined) return false;
  return now - lastAt < restDays(content, kind) * MINUTES_PER_DAY;
}

/** 후보 가운데 쉬지 않는 것만, 다 쉬는 중이면 모두 (다른 후보가 없으면 다시 쓴다) */
export function preferRested<T>(candidates: readonly T[], isResting: (c: T) => boolean): T[] {
  const fresh = candidates.filter((c) => !isResting(c));
  return fresh.length ? fresh : [...candidates];
}
