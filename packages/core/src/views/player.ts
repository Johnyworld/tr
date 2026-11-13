import { occupationTitle } from "../game/occupation.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem } from "../engine/gear.ts";
import { activeCompanions, apartCompanions, BOND_LABELS, bondOf, describeUntil } from "../game/companions.ts";
import { squadMembers } from "../engine/command.ts";
import { factionPolicy } from "../sim/war.ts";
import { TIE_LABELS, tieKnown, tiesOf } from "../game/ties.ts";
import { disciplineOf } from "../game/culture.ts";
import { headingAs, playerCalls } from "../game/acquaintance.ts";
import {
  activeMissionOf,
  checkPromotion,
  commanderOf,
  daysServed,
} from "../game/missions.ts";
import { traitsOf } from "../engine/traits.ts";
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
  /** 성별 이름 (정하지 않았으면 null), 초상화 id */
  genderLabel: string | null;
  portrait: string | null;
  age: number | null;
  roleLabel: string;
  timeLabel: string;
  /** 상태 트랙별 현재 단계 (예: 부상 경상). worsened: 첫 단계에서 나빠졌는지 */
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean }[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  /** 트레잇 (자기 것은 모두 보인다) */
  traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; description: string }[];
  /** 할 줄 아는 스킬 (아마추어 이상) */
  skills: { id: string; label: string; category: string; value: number }[];
  /** 레벨·경험치 (성장 규칙이 없으면 null). next: 다음 레벨까지 필요한 누적 경험치 */
  growth: { level: number; xp: number; next: number; skillPoints: number } | null;
  inventory: { id: string; name: string; quantity: number }[];
  sceneItems: { id: string; name: string; quantity: number }[];
  /** conditionLabel: 상태가 처음과 달라졌을 때만 요약 (예: "부상: 경상") */
  present: { id: string; name: string; rankLabel: string; look: string; conditionLabel: string | null }[];
  /** 직분과 그 사다리의 칸 (기획서 12.6) */
  occupationLabel: string | null;
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
  /** 손에 든 무기·입은 방어구·짐 (기획서 4.8). 물건 규칙이 없으면 null */
  gear: {
    weapon: GearView | null;
    armor: GearView[];
    weight: number;
    capacity: number;
    /** 0 가벼움, 1 무거움(판정 불리), 2 너무 무거움(옮겨 가지 못함) */
    burden: 0 | 1 | 2;
  } | null;
  /** 함께 다니는 사람·동물 (곁에 있거나 잠시 떨어져 있는) */
  companions: { id: string; name: string; bondLabel: string; note: string | null; apart: boolean }[];
  /** 진 빚 (무리 이름 → 양) */
  debts: { name: string; amount: number }[];
  /** 지금 임무로 무기고에서 빌린 것 */
  loan: string[];
  /** 맡은 분대 (분대장일 때) */
  squad: { id: string; name: string; doing: string; report: string | null }[] | null;
  /** 내 무리의 방침 */
  policy: { label: string; option: string }[];
  /** 알게 된 인물 사이의 관계 (예: 오지호 — 오정빈의 형제자매) */
  ties: { key: string; text: string }[];
  /** 아는 인물의 당신에 대한 관계 */
  relations: { id: string; name: string; trust: number; affection: number; respect: number }[];
  /** 내 행적 (최근 것부터). 보이는 목격자만 담는다 */
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  /** 최근 것부터 */
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
};



/** 장비 한 줄 */
export type GearView = { id: string; name: string; slotLabel: string; detail: string; wear: string | null; ammo: string | null };

const SLOT_LABELS: Record<string, string> = { weapon: "손", body: "몸", head: "머리", arms: "팔" };
const HARM_CAP_LABELS: Record<string, string> = { light: "가벼운 피해까지", heavy: "무거운 피해까지" };

function gearView(state: GameState, content: Content): PlayerView["gear"] {
  if (!content.scenario.gear) return null;
  const me = state.characters[state.playerId]!;
  const move = (id: string) => content.scenario.moves.find((m) => m.id === id)?.label ?? id;
  const one = (id: string | null, slot: string): GearView | null => {
    const item = id ? content.items[id] : undefined;
    if (!id || !item) return null;
    const w = item.weapon;
    const a = item.armor;
    const detail = w
      ? [w.moves.map(move).join("·"), HARM_CAP_LABELS[w.max_harm], w.noise >= 2 ? "시끄러움" : w.noise === 0 ? "조용함" : ""].filter(Boolean).join(" · ")
      : a
        ? [a.reduces ? `피해 ${a.reduces}단계 막음` : "", a.blocks_infection ? "물림을 막음" : "", ...Object.entries(a.penalty).map(([m, v]) => `${move(m)} ${v}`)].filter(Boolean).join(" · ")
        : "";
    return {
      id,
      name: item.name,
      slotLabel: SLOT_LABELS[slot] ?? slot,
      detail,
      wear: item.durability ? `${me.wear[id] ?? 0}/${item.durability}` : null,
      ammo: w?.ammo ? `${content.items[w.ammo]?.name ?? w.ammo} ${me.inventory[w.ammo] ?? 0}` : null,
    };
  };
  return {
    weapon: one(equippedItem(me, "weapon"), "weapon"),
    armor: (["body", "head", "arms"] as const).map((s) => one(equippedItem(me, s), s)).filter((x): x is GearView => !!x),
    weight: Math.round(carriedWeight(content, me) * 10) / 10,
    capacity: Math.round(carryCapacity(content, me)),
    burden: encumbrance(content, me),
  };
}

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
    genderLabel: scenario.creation?.genders.find((g) => g.id === player.gender)?.label ?? null,
    portrait: player.portrait,
    age: player.age,
    roleLabel:
      content.roles[state.roleId]?.rank === player.rank
        ? (content.roles[state.roleId]?.label ?? rankLabel(scenario, player.rank))
        : rankLabel(scenario, player.rank),
    occupationLabel: occupationTitle(content, player),
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
    traits: traitsOf(content, player).map((t) => ({ id: t.id, label: t.label, kind: t.kind, description: t.description })),
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
        name: headingAs(state, content, player.id, id),
        // 동물은 계급이 없다 (호칭에 이미 "동물")
        rankLabel: npc.extra && content.extras[npc.extra.template]?.animal ? "" : rankLabel(scenario, npc.rank),
        look: content.npcs[id]?.look ?? npc.extra?.look ?? "",
        conditionLabel: npc.dead ? "사망" : npc.away ? "떠남" : npc.captive ? (state.playerZone === npc.captive.zone ? "붙잡혀 있음" : "행방 모름") : changed(npc) ? describeConditions(scenario, npc) : null,
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
        return checkPromotion(player, scenario.promotion, state.time, state.runStartedAt, trust, disciplineOf(content, player.factionId).maxDisobedience).missing;
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
    gear: gearView(state, content),
    companions: [...activeCompanions(state), ...apartCompanions(state)].map((id) => {
      const bond = bondOf(state, content, id);
      const apart = bond?.apart;
      const note = apart
        ? apart.zone
          ? `${content.locations[apart.zone]?.name ?? apart.zone}에서 기다림`
          : `볼일 (${formatTime(apart.until ?? state.time)}쯤 돌아옴)`
        : bond?.crossroads
          ? "갈림길"
          : bond?.kind === "purpose" && bond.until
            ? describeUntil(content, bond.until)
            : null;
      return { id, name: playerCalls(state, content, id), bondLabel: bond ? BOND_LABELS[bond.kind] : "", note, apart: !!apart };
    }),
    debts: Object.entries(player.debts ?? {}).map(([f, n]) => ({ name: content.factions[f]?.name ?? f, amount: n })),
    loan: (() => {
      const m = activeMissionOf(state.missions, player.id);
      const loan = m ? state.loans?.[m.id] : undefined;
      return loan ? Object.entries(loan).map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""}`) : [];
    })(),
    squad: (() => {
      const members = squadMembers(state, content);
      if (!members.length) return null;
      return members.map((id) => {
        const o = state.squadOrders[id];
        const doing = o
          ? `${content.scenario.command?.squad_tasks.find((t) => t.id === o.task)?.label ?? o.task} (${content.locations[o.zone]?.name ?? o.zone}, ${formatTime(o.until)}쯤)`
          : state.companions.includes(id)
            ? "곁에 있음"
            : "거점";
        return { id, name: playerCalls(state, content, id), doing, report: o ? null : (state.squadReports[id]?.text ?? null) };
      });
    })(),
    policy: player.factionId ? factionPolicy(content, state.factions[player.factionId]).map(({ topic, option }) => ({ label: topic.label, option: option.label })) : [],
    // 알게 된 인물 사이의 관계 (드러난 관계와 털어놓은 관계만, 원칙 4)
    ties: (() => {
      const knownIds = new Set([...(state.known[player.id] ?? []), ...(state.met[player.id] ?? []), player.id]);
      const out = new Map<string, string>();
      for (const id of knownIds) {
        if (id === player.id || !state.characters[id]) continue;
        for (const t of tiesOf(state, content, id)) {
          if (out.has(t.key) || !tieKnown(state, t) || !knownIds.has(t.other)) continue;
          const other = t.other === player.id ? "당신" : playerCalls(state, content, t.other);
          out.set(t.key, `${playerCalls(state, content, id)} — ${other}의 ${TIE_LABELS[t.kind]}`);
        }
      }
      return [...out].map(([key, text]) => ({ key, text }));
    })(),
    // 진짜 관계가 아니라 플레이어가 마지막으로 느낀 태도 (숨은 목격자가 드러나지 않게)
    relations: [...new Set([...(state.known[player.id] ?? []), ...(state.met[player.id] ?? [])])]
      .filter((id) => state.characters[id] && id !== player.id)
      .map((id) => {
        const r = state.perceived[id] ?? NEUTRAL_RELATION;
        return { id, name: playerCalls(state, content, id), ...r };
      }),
    // 숨은 목격자는 UI에도 보내지 않는다
    deeds: Object.values(state.deeds)
      .filter((d) => d.actorId === player.id)
      .map((d) => ({
        id: d.id,
        summary: d.summary,
        tagLabels: d.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: d.witnesses.filter((w) => !w.hidden).map((w) => playerCalls(state, content, w.npcId)),
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
