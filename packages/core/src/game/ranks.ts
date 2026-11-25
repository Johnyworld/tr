import type { Content } from "../content/schemas.ts";
import { rankLabel } from "../scenario/scenario.ts";

/**
 * 무리 안에서 부르는 계급 이름 (12-84). 무리 데이터의 rank_labels가 있으면 그것 (붉은연합의 약탈조원·조장, 버들마을의 정찰대원),
 * 없으면 월드의 계급 이름. 무리가 없으면 월드의 이름
 */
export function rankName(content: Content, factionId: string | null | undefined, rank: string, occupation?: string | null): string {
  // 무리의 계급 이름표는 그 무리의 바깥 일(분대)을 부르는 말이다 (약탈조원, 정찰대원). 분대에 들지 않는 직분이면 월드의 계급 이름으로
  // (12-312, 받아들임 판: 붉은연합 수비대원이 "약탈조원"으로 나왔다)
  const posts = content.scenario.admission?.posts;
  const ownLabels = occupation && posts && !posts.squad.includes(occupation) ? undefined : factionId ? content.factions[factionId]?.rank_labels : undefined;
  return rankLabel(content.scenario, rank, ownLabels);
}
