/**
 * 구해 오는 임무와 찾을 거리 표 검사 (12-355, content:check에서 부른다).
 * 수색은 표대로만 나오고 임무로 찾는 자원을 따로 보장하지 않으므로, 구해 올 것(bring)이 그 임무 자리의 찾을 거리 표(loot)에 있어야 한다.
 * 임무 자리가 구역 id(하나 또는 여럿)로 정해진 것만 본다 (outside·near·enemy는 그때그때 달라 보지 않는다). 여럿이면 하나라도 있으면 된다
 */
import { itemResource } from "../engine/market.ts";
import type { Content } from "./schemas.ts";

export function checkBringLoot(content: Content): string[] {
  const errors: string[] = [];
  const has = (zone: string, want: string) => (content.locations[zone]?.loot?.items ?? []).some((i) => i.item === want || itemResource(content, i.item) === want);
  for (const m of Object.values(content.missions)) {
    const where = m.where;
    if (!where || where === "outside" || where === "near" || where === "enemy") continue;
    const zones = Array.isArray(where) ? where : [where];
    for (const r of m.requirements) {
      if (!("bring" in r)) continue;
      if (!zones.some((z) => has(z, r.bring))) errors.push(`missions.${m.id}: 구해 올 ${r.bring}이 임무 자리(${zones.join(", ")})의 찾을 거리 표에 없다`);
    }
  }
  return errors;
}
