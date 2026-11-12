/** 0 이상 1 미만의 난수를 돌려주는 함수. 모든 난수는 이 형태로 주입한다. */
export type Rng = () => number;

/** 시드 고정 난수 (mulberry32). 테스트와 재현용. */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1 ~ sides 사이의 정수 */
export function rollDie(rng: Rng, sides: number): number {
  return Math.floor(rng() * sides) + 1;
}
