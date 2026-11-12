import { runMissionStartOfTurn } from "./missionTools.ts";
import { spreadRumors } from "./reputationTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 턴 시작 처리. GM 호출 전에 코드가 세계를 진행시킨다.
 * - 소문 전파 (하루 단위, 플레이어에게는 보이지 않음)
 * - 임무 기한 만료, 오늘의 임무 후보
 * 플레이어에게 보여 줄 결과만 돌려준다.
 */
export function runStartOfTurn(ctx: ToolContext): ToolDisplayEvent[] {
  spreadRumors(ctx);
  return runMissionStartOfTurn(ctx);
}
