import type { Content } from "../content/schemas.ts";
import { NEUTRAL_RELATION } from "./reputation.ts";
import type { GameState } from "./state.ts";

/**
 * 명성 (기획서 8.7, 12-127): 주인공이 남에게 보인 행적이 쌓인 양. 한두 번으로는 무명이고, 쌓일수록 소문이 멀리 퍼진다.
 * 팬과 안티: 주인공을 직접 보지 않고 소문으로만 들은 사람 중 마음이 크게 기운 사람 (지금의 관계에서 저절로 정해진다)
 */

export type Fame = { points: number; tier: number; label: string };

/** 이 사람(기본: 주인공)의 명성. 목격자가 있는 행적의 크기 합 */
export function fameOf(state: GameState, content: Content, actorId: string = state.playerId): Fame {
  const rules = content.scenario.fame;
  const points = Object.values(state.deeds)
    // 본 사람이 둘 이상인 일만 이름이 된다 (플레이 테스트 12: 상관 한 사람만 본 임무 완수·점호 결석까지 세어 5일차에 이름난 사람)
    .filter((d) => d.actorId === actorId && d.witnesses.length >= 2)
    .reduce((n, d) => n + d.severity, 0);
  if (!rules) return { points, tier: 0, label: "" };
  let tier = 0;
  rules.tiers.forEach((t, i) => {
    if (points >= t.min) tier = i;
  });
  return { points, tier, label: rules.tiers[tier]!.label };
}

/** 이 사람이 주인공의 팬인지 안티인지: 주인공의 행적을 소문·전해 들음으로만 알고(직접 본 것이 없고), 호감 또는 존중이 크게 기울었다 */
export function stanceOf(state: GameState, content: Content, npcId: string): "fan" | "anti" | null {
  const rules = content.scenario.fame;
  if (!rules) return null;
  const known = Object.entries(state.deedKnowledge[npcId] ?? {}).filter(([deedId]) => state.deeds[deedId]?.actorId === state.playerId);
  if (known.length === 0 || known.some(([, source]) => source === "seen")) return null;
  const r = state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION;
  if (r.affection >= rules.fan_at || r.respect >= rules.fan_at) return "fan";
  if (r.affection <= rules.anti_at || r.respect <= rules.anti_at) return "anti";
  return null;
}
