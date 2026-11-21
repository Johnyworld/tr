/**
 * 치료: 언제 다시 받을 수 있나 (docs/design.md 12-236).
 *
 * 돌봄은 두 칸이다. 같은 날 같은 칸은 한 번이지만, 그 뒤 상처가 더 깊어졌으면 다시 받는다 (새 상처는 새로 돌본다).
 * - healer: 치료사의 치료·수술, 무리의 돌봄
 * - aid: 주인공이 하는 응급처치·간호·수술
 * (플레이 테스트 13: 아침 치료 뒤 저녁의 새 치명상을 "내일 다시"로 막았고, 주인공이 감은 붕대가 그날 외과 의사의 수술을 막았다)
 * 오늘 받았는지는 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { Content } from "../../content/schemas.ts";
import type { GameState } from "../../game/state.ts";
import { dayOf } from "../../rules/time.ts";
import { harmTrack } from "../../scenario/scenario.ts";

export type CareSlot = "healer" | "aid";

/** changeCondition의 by: 이 칸을 쓴다 */
export const CARE_BY: Record<CareSlot, string> = { healer: "healer", aid: "aid" };

/** 오늘 이 칸을 이미 썼고, 그 뒤로 상처가 깊어지지 않았는가 (그러면 오늘은 더 받지 못한다) */
export function careUsedToday(state: GameState, content: Content, patient: string, slot: CareSlot): boolean {
  const day = slot === "healer" ? state.recovery.lastHealerDay[patient] : state.recovery.lastAidDay?.[patient];
  if (day !== dayOf(state.time)) return false;
  const snap = slot === "healer" ? state.recovery.healerSnap?.[patient] : state.recovery.aidSnap?.[patient];
  if (!snap) return true;
  const track = harmTrack(content.scenario);
  const idx = (id: string | undefined) => track.levels.findIndex((l) => l.id === id);
  return idx(state.characters[patient]?.conditions[track.id]) <= idx(snap[track.id]);
}
