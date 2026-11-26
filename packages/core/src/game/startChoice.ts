import type { Content, RoleContent } from "../content/schemas.ts";
import { rankName } from "./ranks.ts";

/**
 * 시나리오 고르기 (기획서 12.4.1): 월드를 고르면 그 월드의 준비된 시나리오 목록이 나온다.
 * 목록은 역할(roles/*.yaml) 중 scenario.order가 있는 것. 해금 조건이 있는 시나리오는 잠긴 채 보이고,
 * 어느 판에서든 조건을 채우면 열린다 (모든 판에 남는다, 기획서 9.12). 해금 id는 역할 id다
 */

export type ScenarioChoice = {
  roleId: string;
  title: string;
  pitch: string;
  /** 누구로 시작하나 (무리와 그 무리에서 부르는 계급 이름. 무리가 없으면 "무소속") */
  who: string;
  /** 잠겨 있으면 해금 조건 (잠긴 카드에 보이는 말). 열려 있으면 null */
  locked: string | null;
  /** 클리어 목표 (없으면 null: 죽음이 끝이다) */
  goal: string | null;
};

/** 목록에 보이는 시나리오인지 */
export const listedScenario = (r: RoleContent): boolean => r.scenario?.order !== undefined;

/** 고를 수 있는지: 해금 조건이 없거나 이미 열렸다 */
export const scenarioOpen = (r: RoleContent, unlocked: readonly string[]): boolean => !r.scenario?.unlock || unlocked.includes(r.id);

/** 시나리오 목록 (열린 것 먼저, 그 안에서 순서대로). 잠긴 것도 아래에 보인다 */
export function scenarioChoices(content: Content, unlocked: readonly string[]): ScenarioChoice[] {
  return Object.values(content.roles)
    .filter(listedScenario)
    // 열린 것 먼저, 잠긴 것은 아래로. 그 안에서는 순서(order)대로
    .sort((a, b) => Number(!scenarioOpen(a, unlocked)) - Number(!scenarioOpen(b, unlocked)) || a.scenario!.order! - b.scenario!.order! || a.id.localeCompare(b.id))
    .map((r) => ({
      roleId: r.id,
      title: r.scenario!.title,
      pitch: r.scenario!.pitch,
      who: r.faction ? `${content.factions[r.faction]?.name ?? r.faction} ${rankName(content, r.faction, r.rank)}` : "무소속",
      locked: scenarioOpen(r, unlocked) ? null : r.scenario!.unlock!.text,
      goal: r.scenario!.goal?.text ?? null,
    }));
}
