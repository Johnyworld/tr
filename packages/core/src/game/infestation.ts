import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import type { Clash, GameState } from "./state.ts";

/**
 * 구역의 감염체 압력 (기획서 7.5.2, 12-112). 0~3, 기준값은 구역의 위험(danger).
 * 총소리와 시체가 감염체를 불러 모으고, 아무 일 없는 날이 이어지면 흩어져 기준값으로 돌아간다.
 * 진짜 값은 World State다. 캐릭터는 그 구역에서 보이는 흔적(GM 상태의 낌새 줄)과 이야기·소문으로만 안다
 */

const clamp = (n: number) => Math.max(0, Math.min(3, n));

/** 구역의 기준 압력: 그 구역의 위험 */
export function baseInfestation(content: Content, zone: string): number {
  return clamp(content.locations[zone]?.danger ?? 0);
}

/** 지금 구역의 감염체 압력 */
export function infestationOf(content: Content, state: Pick<GameState, "infested">, zone: string): number {
  return state.infested?.[zone] ?? baseInfestation(content, zone);
}

export type InfestationChange = { zone: string; level: number; cause: string };

/**
 * 하루가 바뀔 때의 변화 (day: 새로 시작한 날). 전날의 소음과 그날 새벽 교전의 사상자로 오르고,
 * 오르지 않은 구역은 settle 확률로 기준값 쪽으로 한 단계 돌아간다. 기준값에 있는 구역은 난수를 쓰지 않는다
 */
export function infestationDay(content: Content, state: Pick<GameState, "infested" | "zoneNoise" | "facilities">, day: number, clashes: readonly Clash[], rng: Rng): InfestationChange[] {
  const rules = content.scenario.infestation;
  if (!rules) return [];
  const out: InfestationChange[] = [];
  for (const zone of Object.keys(content.locations)) {
    const now = infestationOf(content, state, zone);
    const base = baseInfestation(content, zone);
    const causes: string[] = [];
    const noise = state.zoneNoise[zone];
    // 몰려드는 시간이 정해져 있으면 소음은 그때 따로 (runSwarms)
    if (!rules.swarm_hours && noise && noise.day === day - 1 && noise.level >= rules.noise_at) causes.push("소음");
    const dead = clashes.filter((c) => c.zone === zone).reduce((n, c) => n + c.attackerLosses + c.defenderLosses, 0);
    if (dead >= rules.corpses_at) causes.push("시체");
    if (causes.length) {
      // 바리케이드 (12-176): 막힌 길로는 감염체가 덜 들어온다. 오를 일이 있어도 이 확률로만 오른다
      const rise = barrierRise(content, state, zone);
      if (rise < 1 && rng() >= rise) continue;
      const level = clamp(now + causes.length);
      if (level !== now) out.push({ zone, level, cause: causes.join("·") });
      continue;
    }
    if (now !== base && rng() < rules.settle) out.push({ zone, level: now + Math.sign(base - now), cause: "흩어짐" });
  }
  return out;
}

/** 이 구역의 시설(바리케이드)이 감염체 압력이 오를 확률을 낮추는 배수 (가장 작은 것 하나) */
export function barrierRise(content: Content, state: Pick<GameState, "facilities">, zone: string): number {
  const all = content.scenario.facilities ?? [];
  return (state.facilities?.[zone] ?? []).reduce((r, id) => Math.min(r, all.find((f) => f.id === id)?.effects.infested_rise ?? 1), 1);
}

/** 이 무리 땅 가운데 감염체가 기준값보다 가장 많이 몰려든 구역 (없으면 null) */
export function worstOverrun(content: Content, state: Pick<GameState, "infested" | "zones">, factionId: string): { zone: string; by: number } | null {
  let worst: { zone: string; by: number } | null = null;
  for (const l of Object.values(content.locations)) {
    if (state.zones[l.id]?.owner !== factionId) continue;
    const by = infestationOf(content, state, l.id) - baseInfestation(content, l.id);
    if (by > 0 && (!worst || by > worst.by)) worst = { zone: l.id, by };
  }
  return worst;
}

/**
 * GM 상태의 낌새 줄: 그 구역에 있는 사람이 보고 들을 수 있는 흔적만 (숫자는 내보내지 않는다, 원칙 4).
 * 기준값보다 높거나 낮을 때, 그리고 아주 높을 때
 */
export function infestationSign(content: Content, state: GameState, zone: string): string | null {
  if (!content.scenario.infestation) return null;
  const now = infestationOf(content, state, zone);
  const base = baseInfestation(content, zone);
  if (now >= 3 && now > base) return "감염체가 평소보다 훨씬 많다. 길마다 발자국과 뜯긴 시체, 가까운 곳에서 발 끄는 소리가 끊이지 않는다";
  if (now >= 3) return "감염체가 우글거리는 곳이다. 어디서든 발 끄는 소리가 들린다";
  if (now > base) return "감염체 흔적이 평소보다 많다. 새 발자국과 썩은 냄새, 멀리서 이빨 부딪치는 소리";
  if (now < base) return "감염체 흔적이 평소보다 드물다. 누가 쓸어 낸 듯 조용하다";
  return null;
}
