import type { Rng } from "../rng.ts";
import type { Scenario } from "../scenario/schema.ts";
import type { Content } from "../content/schemas.ts";

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

/** 이름에서 성을 뺀 부분 (세 글자 이상이고 첫 글자가 시나리오의 성이면). 성이 없으면 그대로 */
export function givenOf(name: string, surnames: readonly string[]): string {
  return name.length >= 3 && surnames.includes(name[0]!) ? name.slice(1) : name;
}

/** 월드 인물의 이름을 이 세계에서만 바꾼 것 (인물 id → 원래 이름·바꾼 이름) */
export type NameSwaps = Record<string, { from: string; to: string }>;

/**
 * 주인공 이름이 월드 인물의 이름과 겹치면(성을 뺀 이름이 같으면) 그 인물을 대체 이름으로 바꾼다 (12-260, PT15 분대장:
 * 주인공 "도윤"과 상관 "한도윤"이 서술·요약에서 헷갈렸다). 성은 그대로 두고 이름만 시나리오의 names.stand_ins에서
 * 그 인물의 성별 것부터 고른다. 주인공 이름이나 다른 인물 이름과 겹치는 대체 이름은 건너뛴다
 */
export function nameSwapsFor(content: Content, playerName: string): NameSwaps {
  const names = content.scenario.names;
  if (!names?.stand_ins || !playerName) return {};
  const mine = givenOf(playerName, names.surnames);
  const taken = new Set(Object.values(content.npcs).map((n) => n.name));
  const swaps: NameSwaps = {};
  for (const npc of Object.values(content.npcs)) {
    if (givenOf(npc.name, names.surnames) !== mine) continue;
    const surname = npc.name.length >= 3 && names.surnames.includes(npc.name[0]!) ? npc.name[0]! : "";
    const pool = [...((npc.gender ? names.stand_ins[npc.gender] : undefined) ?? []), ...Object.entries(names.stand_ins).filter(([g]) => g !== npc.gender).flatMap(([, xs]) => xs)];
    const to = pool.map((g) => surname + g).find((full) => givenOf(full, names.surnames) !== mine && !taken.has(full));
    if (!to) continue;
    taken.add(to);
    swaps[npc.id] = { from: npc.name, to };
  }
  return swaps;
}

/** 바꾼 이름을 콘텐츠의 모든 글에 반영한다 (인물 카드·다른 인물의 카드·이야기·시작 장면·안내). 원래 이름 전체가 나오는 곳만 바꾼다 */
export function renameContent<T extends Content>(content: T, swaps: NameSwaps): T {
  const list = Object.values(swaps);
  if (!list.length) return content;
  const swapText = (text: string) => list.reduce((t, s) => t.split(s.from).join(s.to), text);
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? swapText(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(content) as T;
}
