import { heldOf, heldSeenZone } from "../rules/held.ts";
import { sagaQuest } from "../rules/saga.ts";
import { buildMapView, type MapView, buildPlaceMapView, type PlaceMapView } from "./map.ts";
import { resolveLine } from "../engine/resolve.ts";
import { pledges } from "../engine/promises.ts";
import { portraitSections } from "../scenario/scenario.ts";
import { rankName } from "../game/ranks.ts";
import { stashHere, stashPlace } from "../engine/stash.ts";
import { isCreature } from "../game/kinds.ts";
import { feelsLike } from "../engine/climate.ts";
import { occupationTitle } from "../game/occupation.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem } from "../engine/gear.ts";
import { activeCompanions, apartCompanions, BOND_LABELS, bondOf, describeUntil } from "../game/companions.ts";
import { squadMembers, squadOf } from "../engine/command.ts";
import { personProfile, type PersonProfile } from "./person.ts";
import { factionPolicy } from "../sim/war.ts";
import { TIE_LABELS, tieKnown, tiesOf } from "../game/ties.ts";
import { disciplineOf } from "../game/culture.ts";
import { headingAs, knowsDeath, playerCalls, withKnownNames } from "../game/acquaintance.ts";
import {
  activeMissionOf,
  isRequirementMet,
  checkPromotion,
  commanderOf,
  daysServed,
  recentSetback,
  serviceStart,
} from "../game/missions.ts";
import { effectiveSkill, traitsOf } from "../engine/traits.ts";
import { personaChips, personaScale } from "../engine/persona.ts";
import { settingSheet, type SettingSheetRow } from "../rules/self.ts";
import { atMaxLevel, xpForLevel } from "../engine/growth.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { DEED_TAG_LABELS, NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { Character } from "../game/character.ts";
import { memoAccess } from "../game/memo.ts";
import type { Content } from "../content/schemas.ts";
import { calendarDate, formatAgo, formatClock, formatTime, minuteOfDay, MINUTES_PER_DAY, SEGMENT_LABELS, segmentOf, type TimeSegment } from "../rules/time.ts";
import { itemIcon, type IconName } from "../content/icons.ts";
import { conditionPenalty, initialConditions, raiseCost, rankLabel, shownLevel, skillTierLabel, visibleSymptoms } from "../scenario/scenario.ts";
import { describeRequirement } from "../engine/missionTools.ts";
import type { TranscriptEntry } from "../engine/log.ts";
import type { ToolDisplayEvent } from "../engine/toolkit.ts";
import { factionOutlook, WAR_INTEL_TOPIC, WAR_TOPIC, zoneOutlook } from "../engine/warTools.ts";
import { seasonAt, seasonLabel } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { alarmLabel, battleTitle, momentumLabel } from "../engine/battleTools.ts";
import { entrustedHeld, loanOf } from "../rules/entrusted.ts";
import { learned } from "../rules/skill.ts";
import { currentPlace } from "../rules/place.ts";
import { beliefText, deedText } from "../rules/lens.ts";
import { josa } from "../text.ts";

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
  /** 월드 팩 id: 초상화 그림 주소에 쓴다 (12-139) */
  packId: string;
  /** 얼굴 고르기 기회 (12-139): 얼굴이 없으면 고를 수 있는 얼굴 (화풍 섹션). 고를 수 없으면 null */
  portraitChoices: { style: string; label: string; numbered: boolean; faces: string[] }[] | null;
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
  /** 성격 표: 모든 축, 0 포함 (만들 때와 같은 모양) */
  personaScale: { id: string; low: string; high: string; value: number; acting: string }[];
  /** 설정 (4.6.4): 칸 순서, 비밀은 사실과 아는 사람까지 (자기 것) */
  settings: SettingSheetRow[];
  /** 모든 스킬. 0 미만은 익히지 않은 것 */
  /** 스킬 (4.2.1): kind 누구나 하는 일/전문 기술, usable 판정할 수 있는지(못 하는 전문 기술이면 false), tier 단계 이름, raiseCost 한 단계 올리는 점수 */
  skills: { id: string; label: string; category: string; kind: "common" | "expert"; value: number; usable: boolean; learned: number | null; tier: string; raiseCost: number | null; stats: string[] }[];
  /** 레벨·경험치 (성장 규칙이 없으면 null). next: 다음 레벨까지 필요한 누적 경험치 */
  /** skillMax: 스킬을 올릴 수 있는 최고 단계 (상태 화면의 스킬 올리기, 12-139) */
  /** skillMin·skillCosts: 단계마다 올리는 점수 (skillCosts[i]: skillMin+i → +1, 4.2.1) */
  growth: { level: number; xp: number; next: number; skillPoints: number; prev: number; skillMax: number; skillMin: number; skillCosts: number[] } | null;
  /** 지닌 물건 (장비로 걸친 것은 뺀다. 장비는 gear) */
  inventory: ItemView[];
  sceneItems: ItemView[];
  /**
   * 창고 (12-149). label: 지금 넣을 수 있는 자리(사물함·거처)면 그 이름, canPut: 지금 넣을 수 있다,
   * items: 이 구역에 맡겨 둔 것 (꺼낼 수 있다), home: 떠돌이의 거처가 다른 곳이면 그 구역 이름.
   * 넣을 곳도 맡긴 것도 거처도 없으면 null
   */
  stash: { label: string | null; canPut: boolean; items: ItemView[]; home: string | null } | null;
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
  /** 고른 시나리오 (캐릭터 탭). 시나리오가 없는 역할이면 null */
  scenario: { title: string; pitch: string } | null;
  /** 과거 배경: 붕괴 전에 하던 일 (12-84, 캐릭터 탭) */
  past: { label: string; summary: string } | null;
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
  /** plans: 우리 무리 계획의 단계, war: 최근 전황 세 줄 (파트 14-2, ?세력과 같은 데이터) */
  faction: { name: string; about: string; moraleLabel: string; rationLabel: string; plans: string[]; war: string[] } | null;
  /** 지금 있는 구역 */
  zone: { name: string; owner: string } | null;
  /** 구역 안의 지금 장소 (12-244, 공통 규칙 15). 정하지 않았으면 null (헤더는 구역 이름) */
  place: { name: string; indoor: boolean; spawned: boolean } | null;
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
  /** 다짐 (12-164) */
  resolve: string | null;
  /**
   * 할 일 (상태 화면의 "할 일" 칸): 임무·부탁·약속·다짐을 같은 모양으로. 기한이 있는 것이 먼저, 다짐은 맨 끝.
   * steps: 임무의 요구 조건, note: 빌린 장비·다짐의 단계 같은 덧붙임
   */
  todos: TodoView[];
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
  /** 지도 (12-201): 가 본 곳과 그 이웃만 */
  map: MapView | null;
  /** 구역 안 지도 (12-304): 아는 장소와 지금 자리의 모르는 문만 */
  placeMap: PlaceMapView | null;
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

/** 젖은 옷 (12-186): 몸 상태 칩 옆에 보인다. 판정 보정은 없고 체감 기온만 떨어진다 */
function wetSymptom(s: Content["scenario"], state: GameState, id: string): SymptomView[] {
  const wet = s.body?.cold?.climate?.wet;
  return wet && (state.wet?.[id] ?? 0) > 0 ? [{ id: "wet_clothes", label: "젖은 옷", penalty: 0, tone: 2, fatal: false }] : [];
}

/** 장비 한 줄. durability: 남은 내구도 (내구도가 없는 물건은 null) */
/** slot: 자리 id (벗을 때 쓴다) */
export type GearView = { id: string; name: string; slot: string; slotLabel: string; detail: string; durability: { left: number; max: number } | null; ammo: string | null; icon: IconName };

/** 물건 한 칸 */
/** wear: 들거나 입을 수 있는 물건이면 그 자리 id (화면의 착용 단추) */
export type ItemView = { id: string; name: string; quantity: number; icon: IconName; wear?: string };

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
      slot,
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
    capacity: Math.round(carryCapacity(content, me, state)),
    burden: encumbrance(content, me, state),
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

export type TodoView = {
  key: string;
  /** 정렬·키용 (화면에는 보이지 않는다: 모두 같은 퀘스트로, 2026-11-25 사용자 결정) */
  kind: "임무" | "의뢰" | "약속" | "큰 이야기" | "다짐";
  title: string;
  /** 맡긴 사람·약속한 사람 */
  who: string | null;
  /** 머리에 마우스를 올리면 보이는 설명 (임무 설명) */
  detail: string | null;
  /** "기한까지 5시간", "2일 남음". 기한이 없으면 null */
  dueLabel: string | null;
  urgent: boolean;
  steps: { text: string; met: boolean }[];
  note: string | null;
};

/** 퀘스트 목록: 임무 → 받아 준 부탁 → 약속 → 큰 이야기 → 다짐 (부탁·약속은 기한 순) */
function todoViews(state: GameState, content: Content): TodoView[] {
  const me = state.characters[state.playerId]!;
  const out: TodoView[] = [];
  const m = activeMissionOf(state.missions, me.id);
  if (m) {
    const left = m.deadline - state.time;
    const loan = loanOf(state, m.id);
    const cargo = entrustedHeld(state, m.id).cargo;
    out.push({
      key: m.id,
      kind: "임무",
      title: m.title,
      who: state.characters[m.giverId] ? playerCalls(state, content, m.giverId) : null,
      detail: m.briefing,
      dueLabel: left <= 0 ? "기한 지남" : `기한까지 ${timeLeftLabel(left)}`,
      urgent: left < MINUTES_PER_DAY / 2,
      steps: m.requirements.map((r, i) => ({ text: describeRequirement(content.scenario, r, m.progress[i] ?? 0), met: isRequirementMet(r, m.progress[i] ?? 0) })),
      note: [loan ? `빌린 장비 (반납): ${Object.entries(loan).map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""}`).join(", ")}` : null, cargo.length ? `맡은 짐: ${cargo.map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""}`).join(", ")}` : null].filter(Boolean).join(" · ") || null,
    });
  }
  const ps = pledges(state, content);
  for (const kind of ["의뢰", "약속"] as const) {
    for (const p of ps.filter((x) => x.kind === kind)) {
      out.push({ key: p.id, kind, title: p.text, who: p.who, detail: kind === "의뢰" ? `${p.who}의 의뢰를 맡았다` : `${p.who}에게 한 약속`, dueLabel: p.leftLabel, urgent: p.urgent, steps: [], note: null });
    }
  }
  // 큰 이야기 (공통 규칙 24): 설명은 실마리 한 줄, 체크 목록은 지난 막과 지금 막, 기한은 다른 퀘스트와 같이
  const saga = sagaQuest(state, content);
  if (saga) {
    const left = saga.leftMinutes;
    out.push({
      key: saga.key,
      kind: "큰 이야기",
      title: saga.title,
      who: null,
      detail: saga.line ? `${saga.detail} — ${saga.line}` : saga.detail,
      dueLabel: left === null ? null : left <= 0 ? "기한 지남" : `${timeLeftLabel(left)} 남음`,
      urgent: left !== null && left < 2 * MINUTES_PER_DAY,
      steps: saga.steps,
      note: saga.note ? `${saga.note}${saga.zone ? ` → ${saga.zone}` : ""}` : null,
    });
  }
  const vow = resolveLine(state, content);
  if (vow) out.push({ key: "resolve", kind: "다짐", title: vow, who: null, detail: "이 주인공의 큰 줄기", dueLabel: null, urgent: false, steps: [], note: null });
  return out;
}

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
    place: (() => {
      const p = currentPlace(state, content);
      return p ? { name: p.name, indoor: p.indoor, spawned: p.spawned } : null;
    })(),
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
    faction: outlook.own
      ? {
          name: outlook.own.name,
          about: content.factions[player.factionId]?.public ?? "",
          moraleLabel: outlook.own.moraleLabel,
          rationLabel: outlook.own.rationLabel,
          plans: outlook.own.plans.map((p) => `${p.label}: ${p.stage}${p.targetName ? ` (목표는 ${josa(p.targetName, "이라는/라는")} 말)` : ""}`),
          war: (state.beliefs[state.playerId] ?? [])
            .filter((b) => b.topic === WAR_TOPIC || b.topic === WAR_INTEL_TOPIC)
            .slice(-3)
            .reverse()
            .map((b) => `[${formatAgo(state.time, b.learnedAt)} · ${BELIEF_SOURCE_LABELS[b.source]}] ${withKnownNames(state, content, beliefText(state, b))}`),
        }
      : null,
    name: player.name,
    genderLabel: scenario.creation?.genders.find((g) => g.id === player.gender)?.label ?? null,
    portrait: player.portrait,
    packId: content.scenario.id,
    portraitChoices: !player.dead && player.portrait === null && portraitSections(scenario, player.gender).length > 0 ? portraitSections(scenario, player.gender) : null,
    age: player.age,
    roleLabel:
      content.roles[state.roleId]?.rank === player.rank
        ? (content.roles[state.roleId]?.label ?? rankName(content, player.factionId, player.rank, player.occupation?.id))
        : rankName(content, player.factionId, player.rank, player.occupation?.id),
    occupationLabel: occupationTitle(content, player),
    motive: player.motive ? { label: player.motive.label, summary: player.motive.summary } : null,
    scenario: ((s) => (s ? { title: s.title, pitch: s.pitch } : null))(content.roles[state.roleId]?.scenario),
    past: player.past ? { label: player.past.label, summary: player.past.summary } : null,
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
    symptoms: [...symptomViews(scenario, player), ...wetSymptom(scenario, state, player.id)],
    memo: memoAccess(content, player).write ? { text: state.memos[player.id] ?? "" } : null,
    map: buildMapView(state, content),
    placeMap: buildPlaceMapView(state, content),
    conditionPenalty: conditionPenalty(scenario, player),
    dead: player.dead,
    stats: scenario.stats.map((s) => ({ id: s.id, label: s.label, value: player.stats[s.id] ?? 0 })),
    statRange: { min: scenario.ranges.ability.min, max: scenario.ranges.ability.max },
    traits: traitsOf(content, player).map((t) => ({ id: t.id, label: t.label, kind: t.kind, description: t.description })),
    persona: personaChips(content, player),
    personaScale: personaScale(content, player),
    settings: settingSheet(content, state, player, (id) => playerCalls(state, content, id)),
    skills: scenario.moves
      // 익히지 않은 스킬(-1)과 못 하는 전문 기술도 보인다 (사격이 시트에 없어 보였다). 화면이 흐리게 그린다 (4.2.1)
      .map((m) => {
        const learnedValue = learned(scenario, player.skills, m.id);
        return {
          id: m.id,
          label: m.label,
          category: m.category ?? "",
          kind: m.kind,
          value: effectiveSkill(content, player, m.id),
          /** 못 하는 전문 기술이면 false */
          usable: learnedValue !== null,
          /** 배운 값 (트레잇 보정 없이, 못 함이면 null). 올리는 점수는 이 값으로 센다 */
          learned: learnedValue,
          tier: skillTierLabel(scenario, m.id, learnedValue),
          /** 한 단계 올리는 점수 (못 함·최고 단계면 null) */
          raiseCost: learnedValue === null || learnedValue >= scenario.ranges.skill.max ? null : raiseCost(scenario, learnedValue),
          stats: m.stats.map((id) => scenario.stats.find((x) => x.id === id)?.label ?? id),
        };
      }),
    growth: scenario.growth
      ? { level: player.level, xp: player.xp, next: xpForLevel(scenario, atMaxLevel(scenario, player.level) ? player.level : player.level + 1), skillPoints: player.skillPoints, prev: xpForLevel(scenario, player.level), skillMax: scenario.ranges.skill.max, skillMin: scenario.ranges.skill.min, skillCosts: Array.from({ length: scenario.ranges.skill.max - scenario.ranges.skill.min }, (_, i) => raiseCost(scenario, scenario.ranges.skill.min + i)) }
      : null,
    // 소지품은 들거나 입을 수 있는 물건에 그 자리를 붙인다 (상태 화면의 착용 단추, 12-139)
    inventory: items(carried).map((it) => {
      const def = content.items[it.id];
      const wear = content.scenario.gear ? (def?.weapon ? "weapon" : def?.armor?.slot) : undefined;
      return wear ? { ...it, wear } : it;
    }),
    sceneItems: items(state.scene.items),
    stash: (() => {
      const place = stashPlace(content, state);
      const here = items(stashHere(state));
      const homeZone = !player.factionId ? state.homes[player.id] : undefined;
      const home = homeZone && homeZone !== state.playerZone ? (content.locations[homeZone]?.name ?? homeZone) : null;
      if (!place && !here.length && !home) return null;
      return { label: place?.label ?? null, canPut: !!place, items: here, home };
    })(),
    present: state.scene.present.map((id) => {
      const npc = state.characters[id]!;
      return {
        id,
        name: headingAs(state, content, player.id, id),
        // 동물은 계급이 없다 (호칭에 이미 "동물"). 연고(가족·길동무)도 계급 대신 이름 옆의 부르는 말로 (떠돌이 계급 "혼자"를 붙이지 않는다)
        rankLabel: isCreature(content, npc) || bondOf(state, content, id)?.kind === "kin" ? "" : rankName(content, npc.factionId, npc.rank, npc.occupation?.id),
        look: content.npcs[id]?.look ?? npc.extra?.look ?? "",
        conditionLabel: npc.dead && knowsDeath(state, content, npc.id) ? "사망" : npc.away ? "떠남" : heldOf(npc) ? (state.playerZone === heldOf(npc)!.zone ? "붙잡혀 있음" : heldSeenZone(state, npc.id) ? `${content.locations[heldSeenZone(state, npc.id)!]?.name}에 붙잡혀 있음` : "행방 모름") : changed(npc) ? changedConditions(npc) : null,
        states: npc.dead ? [] : symptomViews(scenario, npc),
        note: npc.dead ? null : npc.away ? "떠남" : heldOf(npc) ? (state.playerZone === heldOf(npc)!.zone ? "붙잡혀 있음" : heldSeenZone(state, npc.id) ? `${content.locations[heldSeenZone(state, npc.id)!]?.name}에 붙잡혀 있음` : "행방 모름") : null,
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
      rankLabel: rankName(content, player.factionId, player.rank, player.occupation?.id),
      merit: player.merit,
      disobedience: player.disobedience,
      daysServed: daysServed(state.time, serviceStart(state)),
      promotionMissing: (() => {
        if (player.rank !== scenario.promotion.from) return null;
        const commanderId = commanderOf(state, content);
        // 화면에는 플레이어가 느끼는 신뢰를 보여 준다 (실제 진급 판정은 진짜 관계로 한다)
        const trust = commanderId ? (state.perceived[commanderId]?.trust ?? 0) : null;
        return checkPromotion(player, scenario.promotion, state.time, serviceStart(state), trust, disciplineOf(content, player.factionId).maxDisobedience, recentSetback(state, player.id, commanderId)).missing;
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
    resolve: resolveLine(state, content),
    todos: todoViews(state, content),
    loan: (() => {
      const m = activeMissionOf(state.missions, player.id);
      if (!m) return [];
      const held = entrustedHeld(state, m.id);
      return [...held.loan.map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""}`), ...held.cargo.map(([id, q]) => `${content.items[id]?.name ?? id}${q > 1 ? ` ×${q}` : ""} (맡은 짐)`)];
    })(),
    squad: (() => {
      const members = squadMembers(state, content);
      if (!members.length) {
        // 분대원일 때: 분대장과 같은 분대 사람 (보기만)
        const mine = squadOf(state, content);
        if (!mine) return null;
        const row = (id: string, doing: string) => ({ id, name: playerCalls(state, content, id), doing, report: null, states: symptomViews(scenario, state.characters[id]!) });
        const where = (id: string) => (state.scene.present.includes(id) ? "곁에 있음" : "");
        return [...(mine.leader ? [row(mine.leader, rankName(content, state.characters[mine.leader]!.factionId, state.characters[mine.leader]!.rank, state.characters[mine.leader]!.occupation?.id))] : []), ...mine.mates.map((id) => row(id, where(id)))];
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
        summary: deedText(state, d),
        tagLabels: d.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: d.witnesses.filter((w) => !w.hidden).map((w) => playerCalls(state, content, w.npcId)),
      }))
      .reverse(),
    // 진짜 정확도(accuracy)는 UI에도 보내지 않는다
    beliefs: (state.beliefs[state.playerId] ?? [])
      .map((b) => ({
        id: b.id,
        fact: withKnownNames(state, content, beliefText(state, b)),
        sourceLabel: BELIEF_SOURCE_LABELS[b.source],
        learnedLabel: `${formatAgo(state.time, b.learnedAt)} · ${formatTime(b.learnedAt)}`,
      }))
      .reverse(),
    journal: [],
  };
  const ids = new Set([...view.present, ...view.companions, ...(view.squad ?? []), ...view.relations].map((p) => p.id));
  return { ...view, profiles: Object.fromEntries([...ids].filter((id) => state.characters[id]).map((id) => [id, personProfile(state, content, id)])) };
}
