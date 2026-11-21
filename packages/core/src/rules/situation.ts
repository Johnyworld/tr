/**
 * 공통 규칙 4: 이야기는 주인공의 지금 처지에 맞을 때만 열린다 (docs/design.md "공통 규칙").
 *
 * 주인공의 처지는 situationOf 하나로 정하고, 이야기가 그 처지에 맞는지는 storyFits 하나로 본다.
 * 이야기에 situations를 적지 않으면 이미 있는 표시로 짐작한다 (이야기 893개를 고치지 않게):
 * - 갇힘 태그 → 갇혀 있을 때만, 다른 이야기는 갇혀 있으면 열리지 않는다
 * - 누워 있는 동안의 이야기(bedside) → 누워 있거나 쉬는 중에만
 * - 급한 이야기·깨우는 이야기(when.activities에 sleep) → 깨어 있을 때와 막 잠에서 깬 때
 * - 나머지 → 깨어 있을 때만
 * 탐험·잠입·전투·위협 앞에서는 situations에 그 처지를 적은 이야기만 연다 (그 자리의 일은 엔진이 따로 연다)
 */
import type { Content, StoryletContent } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { isInfected } from "../game/kinds.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { playerHeld } from "./held.ts";

export const SITUATIONS = ["captive", "lying", "exploring", "infiltrating", "battle", "threatened", "awake"] as const;
export type Situation = (typeof SITUATIONS)[number];

/** 쉬는 중으로 치는 활동 (누워 있는 동안의 이야기가 열린다) */
const RESTING = ["sleep", "rest", "wait", "treat"];

/** 적대하는 감염체가 장면에 있다 (스스로 못 움직이는 것은 빼고) */
export function threatInScene(state: GameState, content: Content): string[] {
  return state.scene.present.filter((id) => {
    const c = state.characters[id];
    return !!c && !c.dead && !state.companions.includes(id) && isInfected(content, c) && !incapacitatingSymptom(content.scenario, c);
  });
}

/** 주인공의 지금 처지 (하나로 정한다) */
export function situationOf(state: GameState, content: Content): Situation {
  const me = state.characters[state.playerId];
  if (playerHeld(state)) return "captive";
  if (state.battle) return "battle";
  if (state.infiltration) return "infiltrating";
  if (state.exploration) return "exploring";
  if (threatInScene(state, content).length) return "threatened";
  if ((me && incapacitatingSymptom(content.scenario, me)) || state.lastActivity === "sleep") return "lying";
  return "awake";
}

/** 이 이야기가 지금 처지에 맞는가 */
export function storyFits(s: StoryletContent, state: GameState, content: Content, situation: Situation = situationOf(state, content)): boolean {
  const captivityTag = content.scenario.captivity?.tag;
  const captivityStory = !!captivityTag && s.tags.includes(captivityTag);
  if (situation === "captive" || captivityStory) {
    if (situation !== "captive" || !captivityStory) return false;
    // 격리(12-238)에서는 그 무리를 붙잡은 쪽으로 적은 이야기만 (몸값·탈출을 돕는 "어디서든" 이야기는 열지 않는다)
    const held = state.characters ? playerHeld(state) : null;
    return !held?.quarantine || !!s.when.captors?.includes(held.by);
  }
  if (s.situations?.length) return s.situations.includes(situation);
  switch (situation) {
    case "lying":
      return !!s.bedside || !!s.urgent || !!s.when.activities?.includes("sleep");
    case "awake":
      // 누워 있는 동안의 이야기는 쉬는 중에만 (플레이 테스트 13: 보초를 막 마친 사람에게 "당신이 누운 동안")
      return !s.bedside || RESTING.includes(state.lastActivity ?? "");
    default:
      return false;
  }
}
