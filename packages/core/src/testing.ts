/**
 * 테스트용 고정 콘텐츠와 도우미. index.ts에서 내보내지 않는다.
 */
import type { Content } from "./content/schemas.ts";
import type { Scenario } from "./scenario/schema.ts";
import { createWorldEvent } from "./game/state.ts";
import { InMemoryGameStore } from "./game/store.ts";

/**
 * 테스트용 시나리오. post_apoc과 일부러 다른 ID(sense, search 등)를 써서
 * core가 특정 시나리오에 묶여 있지 않은지도 함께 확인한다.
 */
export const TEST_SCENARIO: Scenario = {
  id: "test_scenario",
  name: "테스트",
  resources: [{ id: "food", label: "식량" }],
  stats: [
    { id: "strength", label: "근력" },
    { id: "agility", label: "민첩" },
    { id: "cool", label: "냉정" },
    { id: "sense", label: "감각" },
    { id: "persuasion", label: "교섭" },
  ],
  moves: [
    { id: "fight", label: "싸우기", stats: ["strength", "agility"] },
    { id: "search", label: "수색하기", stats: ["sense"] },
    { id: "sense_danger", label: "위험 감지", stats: ["sense"] },
    { id: "stealth", label: "은밀 행동", stats: ["agility"] },
    { id: "endure", label: "버티기", stats: ["cool"] },
    { id: "persuade", label: "설득·압박", stats: ["persuasion"] },
  ],
  move_roles: { notice: "sense_danger", stealth: "stealth" },
  condition_tracks: [
    {
      id: "harm",
      label: "부상",
      levels: [
        { id: "none", label: "무사", penalty: 0 },
        { id: "light", label: "경상", penalty: -1 },
        { id: "serious", label: "중상", penalty: -2 },
        { id: "critical", label: "치명상", penalty: -3 },
        { id: "dead", label: "사망", penalty: 0, fatal: true },
      ],
    },
  ],
  harm_track: "harm",
  rank_ladder: [
    { id: "loner", label: "혼자", level: 0 },
    { id: "grunt", label: "하급 전투원", level: 1 },
    { id: "staff", label: "지원 인력", level: 1 },
    { id: "squad_leader", label: "분대장", level: 2 },
    { id: "officer", label: "간부", level: 3 },
  ],
  promotion: { from: "grunt", to: "squad_leader" },
  speech_rules: "speech.yaml",
  gm_tone: "tone.md",
  threats: {
    disturbance_chance_per_hour: { dawn: 0.05, morning: 0.03, day: 0.03, evening: 0.05, night: 0.08 },
    disturbance_details: ["멀리서 들리는 소리"],
  },
  speech: {
    forms: { casual: "반말", polite: "존댓말" },
    to_lower_rank: "casual",
    to_higher_rank: "polite",
    same_rank_older_or_same_age: "casual",
    same_rank_younger: "polite",
    unknown_age: "polite",
  },
  tone: "## 세계\n테스트용 세계.",
};

export const TEST_CONTENT: Content = {
  scenario: TEST_SCENARIO,
  items: {
    kitchen_knife: { id: "kitchen_knife", name: "부엌칼" },
    water_bottle: { id: "water_bottle", name: "물병" },
    radio: { id: "radio", name: "무전기" },
  },
  roles: {
    role_test: {
      id: "role_test",
      label: "테스트 전투원",
      faction: "faction_a",
      rank: "grunt",
      default_name: "신병",
      age: 23,
      opening_scene: "테스트 시작 장면.",
      start_stats: { strength: 1, agility: 2, cool: 0, sense: 1, persuasion: -1 },
      start_inventory: ["kitchen_knife", "water_bottle"],
      access: [],
      storylet_tags: [],
      beliefs_preset: "test_preset",
      known_npcs: ["npc_leader"],
      commander: "npc_leader",
      missions: ["m_guard", "m_scout"],
    },
  },
  npcs: {
    npc_leader: {
      id: "npc_leader",
      name: "강분대",
      faction: "faction_a",
      rank: "squad_leader",
      age: 44,
      look: "귀가 반쯤 없는 40대",
      reputation: "엄한 분대장",
      want: "분대원을 지키는 것",
      fear: "판단 실수",
      values: { discipline: 3 },
      temperament: ["cautious"],
      voice: { style: "짧은 명령조", samples: ["질문은 돌아와서 해."] },
      routine: { day: "초소 순찰" },
      rules: ["불복종을 싫어한다"],
      knows: ["동쪽 초소 교대 시간"],
      doesnt_know: ["정찰조는 C의 포로다 (진실)"],
      secret: { content: "정찰조를 버리고 후퇴했다 (비밀)", reveal_when: "술자리", min_trust: 4 },
      stats: { strength: 1, agility: 1, cool: 2, sense: 1, persuasion: 0 },
      start_inventory: ["radio"],
      playable: true,
    },
    npc_stranger: {
      id: "npc_stranger",
      name: "낯선이",
      faction: "faction_e",
      rank: "grunt",
      age: 30,
      look: "망토를 두른 상인",
      reputation: "E의 상인",
      want: "이익",
      fear: "손해",
      values: {},
      temperament: [],
      voice: { style: "능글맞은 존댓말", samples: ["싸게 드리죠."] },
      routine: {},
      rules: [],
      knows: [],
      doesnt_know: [],
      stats: { strength: 0, agility: 0, cool: 0, sense: 0, persuasion: 2 },
      start_inventory: [],
      playable: false,
    },
  },
  missions: {
    m_guard: {
      id: "m_guard",
      title: "초소 보초",
      briefing: "초소에서 보초를 선다",
      giver_rank: "squad_leader",
      deadline_hours: 12,
      requirements: [{ activity: "guard_duty", minutes: 240 }],
    },
    m_scout: {
      id: "m_scout",
      title: "고가도로 정찰",
      briefing: "고가도로를 살핀다",
      giver_rank: "squad_leader",
      deadline_hours: 12,
      requirements: [
        { check: "sense_danger", min_outcome: "partial" },
        { check: "stealth", min_outcome: "partial" },
      ],
    },
  },
  beliefs: {
    test_preset: {
      id: "test_preset",
      beliefs: [
        { fact: "A는 C와 전쟁 중이다", source: "report", accuracy: "approximate" },
        { fact: "정찰조는 감염체에게 당했다는 소문", source: "rumor", accuracy: "false" },
      ],
    },
  },
};

/** 세계가 만들어진 메모리 저장소 */
export function createTestStore() {
  return new InMemoryGameStore([createWorldEvent(TEST_CONTENT, "role_test", "world_test")]);
}
