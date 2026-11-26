/** 무리 색 (월드 팩의 무리 순서 = core factionColor). 내 지도와 디버그 전황 지도가 같은 색을 쓴다 */
export const FACTION_COLORS = ["#3b82f6", "#22a06b", "#e5484d", "#a78bfa", "#f59e0b", "#14b8a6", "#ec4899", "#84cc16"];
/** 주인 없는 땅 */
export const NO_OWNER = "#8a8f98";
export const factionColorAt = (i: number | undefined): string => (i === undefined || i < 0 ? NO_OWNER : FACTION_COLORS[i % FACTION_COLORS.length]!);
