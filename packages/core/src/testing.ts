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
  },
  roles: {
    role_test: {
      id: "role_test",
      label: "테스트 전투원",
      faction: "faction_a",
      rank: "grunt",
      default_name: "신병",
      start_stats: { strength: 1, agility: 2, cool: 0, sense: 1, persuasion: -1 },
      start_inventory: ["kitchen_knife", "water_bottle"],
      access: [],
      storylet_tags: [],
    },
  },
};

/** 세계가 만들어진 메모리 저장소 */
export function createTestStore() {
  return new InMemoryGameStore([createWorldEvent(TEST_CONTENT.roles.role_test!, "world_test")]);
}
