import { rankName } from "../game/ranks.ts";
import { feelsLike } from "../engine/climate.ts";
import { occupationTitle } from "../game/occupation.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem } from "../engine/gear.ts";
import { activeCompanions, apartCompanions, BOND_LABELS, bondOf, describeUntil } from "../game/companions.ts";
import { squadMembers, squadOf } from "../engine/command.ts";
import { personProfile, type PersonProfile } from "./person.ts";
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
import { effectiveSkill, traitsOf } from "../engine/traits.ts";
import { personaChips } from "../engine/persona.ts";
import { xpForLevel } from "../engine/growth.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { DEED_TAG_LABELS, NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { Character } from "../game/character.ts";
import { memoAccess } from "../game/memo.ts";
import type { Content } from "../content/schemas.ts";
import { calendarDate, formatClock, formatTime, minuteOfDay, MINUTES_PER_DAY, SEGMENT_LABELS, segmentOf, type TimeSegment } from "../rules/time.ts";
import { itemIcon, type IconName } from "../content/icons.ts";
import { conditionPenalty, initialConditions, rankLabel, shownLevel, visibleSymptoms } from "../scenario/scenario.ts";
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
  /**
   * 시계 (12-66): 화면이 시간대 색과 날씨 아이콘을 그린다. 날씨 chill: 그 날씨가 하루에 더하는 추위 단계 (0이면 견딜 만하다)
   */
  /**
   * time: 시각과 시간대 ("05:30 (새벽)"). hhmm: "05:30". minute: 하루 중 몇 분째 (해·달 자리). date: 달력 날짜 (월드가 정했을 때).
   * 며칠째인지는 일지에서 본다
   */
  clock: {
    time: string;
    hhmm: string;
    minute: number;
    segmentLabel: string;
    date: string | null;
    segment: TimeSegment;
    season: string | null;
    weather: { label: string; icon: IconName | null; chill: number } | null;
    /** 기온 (12-98): 바깥, 여기서 쉬면 체감, 체감의 내역. 기온이 없는 월드는 null */
    temperature: { outside: number; feels: number; detail: string } | null;
  };
  /** 상태 트랙별 현재 단계 (예: 부상 경상). worsened: 첫 단계에서 나빠졌는지 */
  /** icon: 트랙의 아이콘 (없으면 null). step: 보이는 단계(0이 처음), penalty: 이 단계의 판정 보정 */
  conditions: { id: string; label: string; levelLabel: string; worsened: boolean; icon: IconName | null; step: number; penalty: number; fatal: boolean }[];
  /**
   * 보이는 증상 (12-74): 원인(트랙)은 숨기고 증상만. 겹치는 증상은 하나. tone: 1 노랑 · 2 주황 · 3 빨강 (판정 보정 크기), fatal: 죽음
   */
  symptoms: SymptomView[];
  conditionPenalty: number;
  dead: boolean;
  stats: { id: string; label: string; value: number }[];
  /** 능력 값의 범위 (칸으로 그릴 때) */
  statRange: { min: number; max: number };
  /** 트레잇 (자기 것은 모두 보인다) */
  traits: { id: string; label: string; kind: "positive" | "negative" | "personality"; description: string }[];
  /** 성격 축 (0이 아닌 것만, 축 순서). label: 쪽 이름(다혈질), level: 1~2, acting: 그 성격이 드러나는 모습 */
  persona: { id: string; label: string; level: number; acting: string }[];
  /** 할 줄 아는 스킬 (아마추어 이상) */
  skills: { id: string; label: string; category: string; value: number }[];
  /** 레벨·경험치 (성장 규칙이 없으면 null). next: 다음 레벨까지 필요한 누적 경험치 */
  growth: { level: number; xp: number; next: number; skillPoints: number; prev: number } | null;
  /** 지닌 물건 (장비로 걸친 것은 뺀다. 장비는 gear) */
  inventory: ItemView[];
  sceneItems: ItemView[];
  /** conditionLabel: 상태가 처음과 달라졌을 때만 요약 (예: "부상: 경상") */
  /**
   * states: 처음과 달라진 몸 상태 (보이는 단계만). step: 트랙의 몇 번째 단계인지 (0이 처음), fatal: 죽음 단계.
   * note: 떠남·붙잡혀 있음·행방 모름. dead: 죽었다
   */
  present: {
    id: string;
    name: string;
    rankLabel: string;
    look: string;
    conditionLabel: string | null;
    states: SymptomView[];
    note: string | null;
    dead: boolean;
    /** 동행이면 함께 다니는 까닭 (예: 동물, 분대원). 동행이 아니면 null */
    bond: string | null;
  }[];
  /** 직분과 그 사다리의 칸 (기획서 12.6) */
  occupationLabel: string | null;
  /** 동기 (12-77) */
  motive: { label: string; summary: string } | null;
  service: {
    /** 계급 이름 (예: 분대원, 분대장) */
    rankLabel: string;
    merit: number;
    disobedience: number;
    daysServed: number;
    /** 진급까지 남은 조건. 진급 대상이 아니면 null */
    promotionMissing: string[] | null;
  };
  /** deadlineLeftLabel: 기한까지 남은 때 ("하루 반", "5시간", "기한 지남"). urgent: 반나절 안 */
  mission: { title: string; briefing: string; deadlineLabel: string; deadlineLeftLabel: string; urgent: boolean; requirements: string[] } | null;
  /** 소속 무리 사정 (거점에서 느끼는 것, 대략). 세력 시뮬레이션이 없으면 null */
  /** about: 무리 소개 (공개된 것, 월드 이야기와 같은 말) */
  faction: { name: string; about: string; moraleLabel: string; rationLabel: string } | null;
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
  /** states: 같이 있는 인물과 같은 증상 목록 */
  companions: { id: string; name: string; bondLabel: string; note: string | null; apart: boolean; states: SymptomView[] }[];
  /** 진 빚 (무리 이름 → 양) */
  debts: { name: string; amount: number }[];
  /** 지금 임무로 무기고에서 빌린 것 */
  loan: string[];
  /** 맡은 분대 (분대장일 때), 또는 속한 분대 (분대원일 때: 분대장이 맨 위, doing은 계급) */
  squad: { id: string; name: string; doing: string; report: string | null; states: SymptomView[] }[] | null;
  /** 내 무리의 방침 */
  policy: { label: string; option: string }[];
  /** 알게 된 인물 사이의 관계 (예: 오지호 — 오정빈의 형제자매) */
  ties: { key: string; text: string }[];
  /** 아는 인물의 당신에 대한 관계 */
  /** 게임 안에서 직접 마주쳐 태도를 본 사람 (perceived). 이름만 알거나 지난 삶에서 알던 사람은 아직 태도를 모르니 빠진다. dead: 죽었다 (?인물과 같은 기준) */
  relations: { id: string; name: string; trust: number; affection: number; respect: number; dead: boolean }[];
  /** 시트에 이름이 나오는 인물(같이 있는 인물, 동행, 분대, 관계)마다 ?인물과 같은 정보 (이름 툴팁) */
  profiles: Record<string, PersonProfile>;
  /** 내 행적 (최근 것부터). 보이는 목격자만 담는다 */
  deeds: { id: string; summary: string; tagLabels: string[]; visibleWitnesses: string[] }[];
  /** 최근 것부터 */
  beliefs: { id: string; fact: string; sourceLabel: string; learnedLabel: string }[];
  /** 메모 (12-75): 메모장과 펜·연필이 있으면 {text}. 없으면 null (메모 탭이 닫힌다) */
  memo: { text: string } | null;
  /** 지난 일 요약 (최근 것부터, 현재 캐릭터의 것만). scene: 장면을 매듭지은 요약. GameWorld.playerView가 채운다 (?일지와 같은 기록) */
  journal: { key: string; timeLabel: string; scene: boolean; text: string }[];
};



/** 화면에 보이는 증상 하나 */
export type SymptomView = { id: string; label: string; penalty: number; tone: 1 | 2 | 3; fatal: boolean };

/** 증상 → 화면용 (색은 판정 보정 크기로, 죽음 묶음은 fatal) */
function symptomViews(s: Content["scenario"], c: Pick<Character, "conditions">): SymptomView[] {
  return visibleSymptoms(s, c).map((x) => ({
    id: x.id,
    label: x.label,
    penalty: x.penalty,
    tone: x.tone ?? (x.penalty <= -3 ? 3 : x.penalty <= -2 ? 2 : 1),
    fatal: x.group === "death",
  }));
}

/** 장비 한 줄. durability: 남은 내구도 (내구도가 없는 물건은 null) */
export type GearView = { id: string; name: string; slotLabel: string; detail: string; durability: { left: number; max: number } | null; ammo: string | null; icon: IconName };

/** 물건 한 칸 */
export type ItemView = { id: string; name: string; quantity: number; icon: IconName };

/** 기한까지 남은 때를 말로 (분 단위) */
export function timeLeftLabel(minutes: number): string {
  if (minutes <= 0) return "기한 지남";
  if (minutes < 60) return "1시간 안";
  if (minutes < MINUTES_PER_DAY) return `${Math.ceil(minutes / 60)}시간`;
  const halves = Math.round((minutes / MINUTES_PER_DAY) * 2);
  const days = Math.floor(halves / 2);
  const words = ["", "하루", "이틀", "사흘", "나흘", "닷새", "엿새", "이레"];
  return `${words[days] ?? `${days}일`}${halves % 2 ? " 반" : ""}`;
}

const SLOT_LABELS: Record<string, string> = { weapon: "손", body: "몸", head: "머리", arms: "팔", outer: "외투" };
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
      durability: item.durability ? { left: Math.max(0, item.durability - (me.wear[id] ?? 0)), max: item.durability } : null,
      ammo: w?.ammo ? `${content.items[w.ammo]?.name ?? w.ammo} ${me.inventory[w.ammo] ?? 0}` : null,
      icon: itemIcon(item),
    };
  };
  return {
    weapon: one(equippedItem(me, "weapon"), "weapon"),
    armor: (["body", "head", "arms", "outer"] as const).map((s) => one(equippedItem(me, s), s)).filter((x): x is GearView => !!x),
    weight: Math.round(carriedWeight(content, me) * 10) / 10,
    capacity: Math.round(carryCapacity(content, me)),
    burden: encumbrance(content, me),
  };
}

function clockView(state: GameState, content: Content): PlayerView["clock"] {
  const s = content.scenario;
  const weather = weatherNow(s, state);
  return {
    time: formatClock(state.time),
    hhmm: formatClock(state.time).slice(0, 5),
    minute: minuteOfDay(state.time),
    segmentLabel: SEGMENT_LABELS[segmentOf(state.time)],
    date: s.world?.calendar_start ? calendarDate(s.world.calendar_start, state.time) : null,
    segment: segmentOf(state.time),
    season: seasonLabel(seasonAt(s, state.time)) || null,
    weather: weather ? { label: weather.label, icon: weather.icon ?? null, chill: s.body?.cold?.weather[weather.id] ?? 0 } : null,
    temperature: temperatureView(state, content),
  };
}

function temperatureView(state: GameState, content: Content): PlayerView["clock"]["temperature"] {
  const f = feelsLike(content, state, "rest");
  return f ? { outside: f.outside.value, feels: f.value, detail: f.parts.join(", ") } : null;
}

/** 죽은 사람은 맨 아래로 (나머지 순서는 그대로) */
const deadLast = (a: { dead: boolean }, b: { dead: boolean }) => Number(a.dead) - Number(b.dead);

export function buildPlayerView(state: GameState, content: Content): PlayerView {
  const scenario = content.scenario;
  const player = state.characters[state.playerId]!;
  const initial = initialConditions(scenario);
  const changed = (c: { conditions: Record<string, string> }) =>
    Object.entries(initial).some(([track, level]) => c.conditions[track] !== level);
  /** 처음과 달라진 상태만, 보이는 단계 이름으로 (예: "경상 · 허기짐"). 잠복처럼 아직 안 보이면 빼고, 다 안 보이면 null */
  const changedConditions = (c: { conditions: Record<string, string> }) => {
    // 증상이 정해진 월드는 증상만 (겹치는 증상은 하나, 12-74)
    if (scenario.symptoms?.length) {
      const list = visibleSymptoms(scenario, c);
      return list.length ? list.map((x) => x.label).join(" · ") : null;
    }
    const labels = scenario.condition_tracks
      .map((track) => shownLevel(track, c.conditions[track.id]))
      .filter((level, i) => level.id !== initial[scenario.condition_tracks[i]!.id])
      .map((level) => level.label);
    return labels.length ? labels.join(" · ") : null;
  };
  const items = (inv: Record<string, number>): ItemView[] =>
    Object.entries(inv)
      .filter(([, quantity]) => quantity > 0)
      .map(([id, quantity]) => ({ id, name: content.items[id]?.name ?? id, quantity, icon: itemIcon(content.items[id]) }));
  // 장비로 걸친 것은 소지품에서 하나씩 뺀다 (장비 블록에 따로 보인다)
  const carried = { ...player.inventory };
  if (content.scenario.gear) {
    for (const slot of ["weapon", "body", "head", "arms", "outer"] as const) {
      const id = equippedItem(player, slot);
      if (id) carried[id] = (carried[id] ?? 0) - 1;
    }
  }
  const outlook = factionOutlook(state, content);
  const zone = zoneOutlook(state, content);
  const b = state.battle;
  const bc = content.scenario.battle;
  const view: Omit<PlayerView, "profiles"> = {
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
    faction: outlook.own ? { name: outlook.own.name, about: content.factions[player.factionId]?.public ?? "", moraleLabel: outlook.own.moraleLabel, rationLabel: outlook.own.rationLabel } : null,
    name: player.name,
    genderLabel: scenario.creation?.genders.find((g) => g.id === player.gender)?.label ?? null,
    portrait: player.portrait,
    age: player.age,
    roleLabel:
      content.roles[state.roleId]?.rank === player.rank
        ? (content.roles[state.roleId]?.label ?? rankName(content, player.factionId, player.rank))
        : rankName(content, player.factionId, player.rank),
    occupationLabel: occupationTitle(content, player),
    motive: player.motive ? { label: player.motive.label, summary: player.motive.summary } : null,
    clock: clockView(state, content),
    timeLabel: [formatTime(state.time), seasonLabel(seasonAt(content.scenario, state.time)), weatherNow(content.scenario, state)?.label ?? ""]
      .filter(Boolean)
      .join(" · "),
    conditions: scenario.condition_tracks.map((track) => {
      const shown = shownLevel(track, player.conditions[track.id]);
      return {
        id: track.id,
        label: track.label,
        levelLabel: shown.label,
        worsened: shown.id !== initial[track.id],
        icon: track.icon ?? null,
        step: track.levels.indexOf(shown),
        penalty: shown.penalty,
        fatal: !!shown.fatal,
      };
    }),
    symptoms: symptomViews(scenario, player),
    memo: memoAccess(content, player).write ? { text: state.memos[player.id] ?? "" } : null,
    conditionPenalty: conditionPenalty(scenario, player),
    dead: player.dead,
    stats: scenario.stats.map((s) => ({ id: s.id, label: s.label, value: player.stats[s.id] ?? 0 })),
    statRange: { min: scenario.ranges.ability.min, max: scenario.ranges.ability.max },
    traits: traitsOf(content, player).map((t) => ({ id: t.id, label: t.label, kind: t.kind, description: t.description })),
    persona: personaChips(content, player),
    skills: scenario.moves
      .map((m) => ({ id: m.id, label: m.label, category: m.category ?? "", value: effectiveSkill(content, player, m.id) }))
      .filter((m) => m.value >= 0),
    growth: scenario.growth
      ? { level: player.level, xp: player.xp, next: xpForLevel(scenario, player.level + 1), skillPoints: player.skillPoints, prev: xpForLevel(scenario, player.level) }
      : null,
    inventory: items(carried),
    sceneItems: items(state.scene.items),
    present: state.scene.present.map((id) => {
      const npc = state.characters[id]!;
      return {
        id,
        name: headingAs(state, content, player.id, id),
        // 동물은 계급이 없다 (호칭에 이미 "동물"). 연고(가족·길동무)도 계급 대신 이름 옆의 부르는 말로 (떠돌이 계급 "혼자"를 붙이지 않는다)
        rankLabel: (npc.extra && content.extras[npc.extra.template]?.animal) || bondOf(state, content, id)?.kind === "kin" ? "" : rankName(content, npc.factionId, npc.rank),
        look: content.npcs[id]?.look ?? npc.extra?.look ?? "",
        conditionLabel: npc.dead ? "사망" : npc.away ? "떠남" : npc.captive ? (state.playerZone === npc.captive.zone ? "붙잡혀 있음" : "행방 모름") : changed(npc) ? changedConditions(npc) : null,
        states: npc.dead ? [] : symptomViews(scenario, npc),
        note: npc.dead ? null : npc.away ? "떠남" : npc.captive ? (state.playerZone === npc.captive.zone ? "붙잡혀 있음" : "행방 모름") : null,
        dead: npc.dead,
        bond: !npc.dead && state.companions.includes(id) ? (() => {
          const b = bondOf(state, content, id);
          return b ? BOND_LABELS[b.kind] : null;
        })() : null,
      };
    })
      // 동행이 먼저, 죽은 사람은 맨 아래
      .sort((a, b) => deadLast(a, b) || Number(b.bond !== null) - Number(a.bond !== null)),
    service: {
      rankLabel: rankName(content, player.factionId, player.rank),
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
        deadlineLeftLabel: timeLeftLabel(m.deadline - state.time),
        urgent: m.deadline - state.time < MINUTES_PER_DAY / 2,
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
      const c = state.characters[id];
      return { id, name: playerCalls(state, content, id), bondLabel: bond ? BOND_LABELS[bond.kind] : "", note, apart: !!apart, states: c ? symptomViews(scenario, c) : [] };
    }),
    debts: Object.entries(player.debts ?? {}).map(([f, n]) => ({ name: content.factions[f]?.name ?? f, amount: n })),
    loan: (() => {
      const m = activeMissionOf(state.missions, player.id);
      const loan = m ? state.loans?.[m.id] : undefined;
      return loan ? Object.entries(loan).map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""}`) : [];
    })(),
    squad: (() => {
      const members = squadMembers(state, content);
      if (!members.length) {
        // 분대원일 때: 분대장과 같은 분대 사람 (보기만)
        const mine = squadOf(state, content);
        if (!mine) return null;
        const row = (id: string, doing: string) => ({ id, name: playerCalls(state, content, id), doing, report: null, states: symptomViews(scenario, state.characters[id]!) });
        const where = (id: string) => (state.scene.present.includes(id) ? "곁에 있음" : "");
        return [...(mine.leader ? [row(mine.leader, rankName(content, state.characters[mine.leader]!.factionId, state.characters[mine.leader]!.rank))] : []), ...mine.mates.map((id) => row(id, where(id)))];
      }
      return members.map((id) => {
        const o = state.squadOrders[id];
        const doing = o
          ? `${content.scenario.command?.squad_tasks.find((t) => t.id === o.task)?.label ?? o.task} (${content.locations[o.zone]?.name ?? o.zone}, ${formatTime(o.until)}쯤)`
          : state.companions.includes(id)
            ? "곁에 있음"
            : "거점";
        const c = state.characters[id];
        return {
          id,
          name: playerCalls(state, content, id),
          doing,
          report: o ? null : (state.squadReports[id]?.text ?? null),
          states: c ? symptomViews(scenario, c) : [],
        };
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
    relations: Object.keys(state.perceived)
      .filter((id) => state.characters[id] && id !== player.id)
      .map((id) => {
        const r = state.perceived[id] ?? NEUTRAL_RELATION;
        return { id, name: playerCalls(state, content, id), ...r, dead: state.characters[id]!.dead };
      })
      .sort(deadLast),
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
    journal: [],
  };
  const ids = new Set([...view.present, ...view.companions, ...(view.squad ?? []), ...view.relations].map((p) => p.id));
  return { ...view, profiles: Object.fromEntries([...ids].filter((id) => state.characters[id]).map((id) => [id, personProfile(state, content, id)])) };
}
