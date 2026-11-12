import { runMissionStartOfTurn } from "./missionTools.ts";
import { spreadRumors } from "./reputationTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 시간이 흐른 뒤 세계 처리. take_action이 시간을 흘린 직후와 세계를 처음 열 때 부른다.
 * - 소문 전파 (하루 단위, 플레이어에게는 보이지 않음)
 * - 임무 기한 만료, 오늘의 임무 후보
 * 이렇게 하면 다음 장면(GM이 받는 상태)이 항상 처리가 끝난 상태다.
 * 플레이어에게 보여 줄 결과만 돌려준다.
 */
export function runAfterTimeAdvance(ctx: ToolContext): ToolDisplayEvent[] {
  spreadRumors(ctx);
  return runMissionStartOfTurn(ctx);
}
