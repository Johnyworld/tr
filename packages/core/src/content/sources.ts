/**
 * 물건을 구할 만한 곳 (12-239): 콘텐츠에서 그 물건을 들여오는 장사꾼과 뒤져서 나오는 구역.
 * 부탁을 받을 때 "구할 만한 곳"으로 보이고 (플레이 테스트 13: 부탁한 메모장을 어디서 구하는지 몰라 상인을 하나씩 불렀다),
 * content:check가 부탁 물건이 세계 어딘가에 있는지 본다. 장사꾼은 이름 대신 있는 곳으로 부른다 (모르는 이름을 드러내지 않는다)
 */
import type { Content } from "./schemas.ts";

export function itemSources(content: Content, itemId: string): string[] {
  const out: string[] = [];
  const place = (id: string | undefined) => (id ? (content.locations[id]?.name ?? id) : null);
  for (const npc of Object.values(content.npcs)) {
    const m = npc.merchant;
    if (!m || !(itemId in m.restock || itemId in m.rare)) continue;
    const where = place(npc.zone) ?? place(npc.roams?.[0]);
    if (where) out.push(`${where}의 장사꾼`);
  }
  for (const l of Object.values(content.locations)) if (l.loot?.items.some((i) => i.item === itemId)) out.push(`${l.name} 뒤지기`);
  return [...new Set(out)];
}
