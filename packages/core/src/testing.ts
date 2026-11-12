/**
 * 테스트용 고정 콘텐츠와 도우미. index.ts에서 내보내지 않는다.
 */
import type { Content } from "./content/schemas.ts";
import { createWorldEvent } from "./game/state.ts";
import { InMemoryGameStore } from "./game/store.ts";

export const TEST_CONTENT: Content = {
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
      start_stats: { strength: 1, agility: 2, cool: 0, sense: 1, persuasion: -1 },
      start_inventory: ["kitchen_knife", "water_bottle"],
      access: [],
      storylet_tags: [],
      beliefs_preset: "test_preset",
      known_npcs: ["npc_leader"],
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
      secret: { content: "정찰조를 버리고 후퇴했다 (비밀)", reveal_when: "신뢰 4" },
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
