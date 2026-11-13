import type { NpcContent } from "../content/schemas.ts";
import { dayOf, type GameTime } from "../rules/time.ts";

/**
 * 이름 있는 인물이 지금 있을 만한 구역 (기획서 7.11). 떠도는 인물(roams)은 날마다 자리를 옮긴다.
 * 날짜와 id로 정해지므로 상태도 RNG도 쓰지 않는다 (같은 날이면 늘 같은 곳)
 */
export function npcZoneAt(npc: Pick<NpcContent, "id" | "zone" | "roams">, time: GameTime): string | undefined {
  if (!npc.roams?.length) return npc.zone;
  let h = 0;
  for (const ch of npc.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return npc.roams[(dayOf(time) + h) % npc.roams.length];
}
