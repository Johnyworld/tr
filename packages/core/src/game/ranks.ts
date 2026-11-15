import type { Content } from "../content/schemas.ts";
import { rankLabel } from "../scenario/scenario.ts";

/**
 * 무리 안에서 부르는 계급 이름 (12-84). 무리 데이터의 rank_labels가 있으면 그것 (붉은연합의 약탈조원·조장, 버들마을의 정찰대원),
 * 없으면 월드의 계급 이름. 무리가 없으면 월드의 이름
 */
export function rankName(content: Content, factionId: string | null | undefined, rank: string): string {
  return rankLabel(content.scenario, rank, factionId ? content.factions[factionId]?.rank_labels : undefined);
}
