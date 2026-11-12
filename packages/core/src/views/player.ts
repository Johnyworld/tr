import {
  activeMissionOf,
  checkPromotion,
  commanderOf,
  daysServed,
} from "../game/missions.ts";
import { xpForLevel } from "../engine/growth.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { DEED_TAG_LABELS, NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { Content } from "../content/schemas.ts";
import { formatTime } from "../rules/time.ts";
import { conditionPenalty, describeConditions, initialConditions, rankLabel, shownLevel } from "../scenario/scenario.ts";
import { describeRequirement } from "../engine/missionTools.ts";
import type { TranscriptEntry } from "../engine/log.ts";
import type { ToolDisplayEvent } from "../engine/toolkit.ts";
import { factionOutlook, zoneOutlook } from "../engine/warTools.ts";
import { seasonAt, seasonLabel } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { alarmLabel, battleTitle, momentumLabel } from "../engine/battleTools.ts";

/**
 * 웹 앱 화면용 조회 결과. 정보 필터를 거친다 (원칙 4, 9: 필터는 어댑터가 아니라 core에서).
 * - 관계는 진짜 값이 아니라 플레이어가 마지막으로 느낀 태도
 * - 숨은 목격자, 믿음의 진짜 정확도는 넣지 않는다
 */

/** UI에 보여 줄 플레이어 시트 */
export type PlayerView = {
  name: string;
  roleLabel: string;
  timeLabel: string;
  /** 상태 트랙별 현재 단계 (예: 부상 경상). worsened: 첫 단계에서 나빠졌는지 */
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean }[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  /** 할 줄 아는 스킬 (아마추어 이상) */
  skills: { id: string; label: string; category: string; value: number }[];
  /** 레벨·경험치 (성장 규칙이 없으면 null). next: 다음 레벨까지 필요한 누적 경험치 */
  growth: { level: number; xp: number; next: number; skillPoints: number } | null;
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  /** conditionLabel: 상태가 처음과 달라졌을 때만 요약 (예: "부상: 경상") */
  present: { id: string; name: string; rankLabel: string; look: string; conditionLabel: string | null }[];
  service: {
    merit: number;
    disobedience: number;
    daysServed: number;
    /** 진급까지 남은 조건. 진급 대상이 아니면 null */
    promotionMissing: string[] | null;
  };
  mission: { title: string; briefing: string; deadlineLabel: string; requirements: string[] } | null;
  /** 소속 무리 사정 (거점에서 느끼는 것, 대략). 세력 시뮬레이션이 없으면 null */
  faction: { name: string; moraleLabel: string; rationLabel: string } | null;
  /** 지금 있는 구역 */
  zone: { name: string; owner: string } | null;
  /** 진행 중인 전투 (대략적인 말로만) */
  battle: { title: string; sideLabel: string; round: string; momentum: number; momentumMax: number; momentumLabel: string; alarmLabel: string; positionLabel: string } | null;
  /** 아는 인물의 당신에 대한 관계 */
  relations: { id: string; name: string; trust: number; affection: number; respect: number }[];
  /** 내 행적 (최근 것부터). 보이는 목격자만 담는다 */
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  /** 최근 것부터 */
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};

/** UI에 보낼 대화 기록. 모델에 보낸 프롬프트 원문은 빼고 보낸다 */
export type TranscriptView =
  | { kind: "player"; text: string }
  | { kind: "gm"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; display: ToolDisplayEvent };


export function buildPlayerView(state: GameState, content: Content): PlayerView {
  const scenario = content.scenario;
  const player = state.characters[state.playerId]!;
  const initial = initialConditions(scenario);
  const changed = (c: { conditions: Record<string, string> }) =>
    Object.entries(initial).some(([track, level]) => c.conditions[track] !== level);
  const items = (inv: Record<string, number>) =>
    Object.entries(inv).map(([id, quantity]) => ({ id, name: content.items[id]?.name ?? id, quantity }));
  const outlook = factionOutlook(state, content);
  const zone = zoneOutlook(state, content);
  const b = state.battle;
  const bc = content.scenario.battle;
  return {
    zone: zone ? { name: zone.name, owner: zone.owner } : null,
    battle:
      b && bc
        ? {
            title: battleTitle(content, b),
            sideLabel: b.side === "defense" ? "방어" : "공격",
            round: `${b.round + 1}/${bc.max_rounds}`,
            momentum: b.momentum,
            momentumMax: bc.momentum_to_win,
            momentumLabel: momentumLabel(b.momentum, bc.momentum_to_win),
            alarmLabel: alarmLabel(b.alarm, bc.max_alarm),
            positionLabel: bc.positions.find((p) => p.id === b.position)?.label ?? b.position,
          }
        : null,
    faction: outlook.own ? { name: outlook.own.name, moraleLabel: outlook.own.moraleLabel, rationLabel: outlook.own.rationLabel } : null,
    name: player.name,
    roleLabel:
      content.roles[state.roleId]?.rank === player.rank
        ? (content.roles[state.roleId]?.label ?? rankLabel(scenario, player.rank))
        : rankLabel(scenario, player.rank),
    timeLabel: [formatTime(state.time), seasonLabel(seasonAt(content.scenario, state.time)), weatherNow(content.scenario, state)?.label ?? ""]
      .filter(Boolean)
      .join(" · "),
    conditions: scenario.condition_tracks.map((track) => ({
      id: track.id,
      label: track.label,
      levelLabel: shownLevel(track, player.conditions[track.id]).label,
      worsened: shownLevel(track, player.conditions[track.id]).id !== initial[track.id],
    })),
    conditionPenalty: conditionPenalty(scenario, player),
    dead: player.dead,
    stats: scenario.stats.map((s) => ({ id: s.id, label: s.label, value: player.stats[s.id] ?? 0 })),
    skills: scenario.moves
      .map((m) => ({ id: m.id, label: m.label, category: m.category ?? "", value: player.skills[m.id] ?? m.default }))
      .filter((m) => m.value >= 0),
    growth: scenario.growth
      ? { level: player.level, xp: player.xp, next: xpForLevel(scenario, player.level + 1), skillPoints: player.skillPoints }
      : null,
    inventory: items(player.inventory),
    sceneItems: items(state.scene.items),
    present: state.scene.present.map((id) => {
      const npc = state.characters[id]!;
      return {
        id,
        name: npc.name,
        rankLabel: rankLabel(scenario, npc.rank),
        look: content.npcs[id]?.look ?? "",
        conditionLabel: npc.dead ? "사망" : changed(npc) ? describeConditions(scenario, npc) : null,
      };
    }),
    service: {
      merit: player.merit,
      disobedience: player.disobedience,
      daysServed: daysServed(state.time, state.runStartedAt),
      promotionMissing: (() => {
        if (player.rank !== scenario.promotion.from) return null;
        const commanderId = commanderOf(state, content);
        // 화면에는 플레이어가 느끼는 신뢰를 보여 준다 (실제 진급 판정은 진짜 관계로 한다)
        const trust = commanderId ? (state.perceived[commanderId]?.trust ?? 0) : null;
        return checkPromotion(player, scenario.promotion, state.time, state.runStartedAt, trust).missing;
      })(),
    },
    mission: (() => {
      const m = activeMissionOf(state.missions, player.id);
      if (!m) return null;
      return {
        title: m.title,
        briefing: m.briefing,
        deadlineLabel: formatTime(m.deadline),
        requirements: m.requirements.map((r, i) => describeRequirement(scenario, r, m.progress[i] ?? 0)),
      };
    })(),
    // 진짜 관계가 아니라 플레이어가 마지막으로 느낀 태도 (숨은 목격자가 드러나지 않게)
    relations: (state.known[player.id] ?? []).map((id) => {
      const r = state.perceived[id] ?? NEUTRAL_RELATION;
      return { id, name: state.characters[id]?.name ?? id, ...r };
    }),
    // 숨은 목격자는 UI에도 보내지 않는다
    deeds: Object.values(state.deeds)
      .filter((d) => d.actorId === player.id)
      .map((d) => ({
        id: d.id,
        summary: d.summary,
        tagLabels: d.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: d.witnesses.filter((w) => !w.hidden).map((w) => state.characters[w.npcId]?.name ?? w.npcId),
      }))
      .reverse(),
    // 진짜 정확도(accuracy)는 UI에도 보내지 않는다
    beliefs: (state.beliefs[state.playerId] ?? [])
      .map((b) => ({
        id: b.id,
        fact: b.fact,
        sourceLabel: BELIEF_SOURCE_LABELS[b.source],
        learnedLabel: formatTime(b.learnedAt),
      }))
      .reverse(),
  };
}
/** 화면에 보낼 대화 기록. 모델에 보낸 프롬프트 원문은 빼고, 보여 주지 않을 결과는 거른다 */
export function buildTranscriptView(transcript: readonly TranscriptEntry[]): TranscriptView[] {
  return transcript.map((e) => (e.kind === "player" ? { kind: "player", text: e.text } : e));
}
