/**
 * 사람 정보를 한 곳에서 (12-241): 파는 물건, 꺼낼 부탁, 가르칠 수 있는 것.
 * GM 카드(context.ts), 인물을 들인 결과(npc_presence), 플레이어의 ?인물(views/person.ts)이 모두 이것을 쓴다
 * (플레이 테스트 13: 들인 결과에 카드가 없어 같은 턴 흥정이 실패했고, 가르칠 수 있는 것은 콘텐츠 파일을 뒤져야 알았다).
 * 플레이어에게는 꺼내지 않은 부탁을 보이지 않는다 (원칙 4)
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { teachable } from "../rules/skill.ts";
import { askedPromises } from "./promises.ts";

export type PersonFacts = { sells: string[]; asks: string[]; teaches: string[] };

export function personFacts(state: GameState, content: Content, id: string, forGm: boolean): PersonFacts {
  const c = state.characters[id];
  if (!c) return { sells: [], asks: [], teaches: [] };
  const merchant = !!content.npcs[id]?.merchant;
  const sells = merchant ? Object.entries(c.inventory).filter(([, q]) => q > 0).map(([item, q]) => `${content.items[item]?.name ?? item} ×${q}`) : [];
  const asks = forGm
    ? askedPromises(state, id).flatMap((p) => {
        const f = p.favor ? content.npcs[id]?.favors?.find((x) => x.id === p.favor) : undefined;
        return f ? [`${content.items[f.item.id]?.name ?? f.item.id} ×${f.item.quantity} (${p.id})`] : [];
      })
    : [];
  return { sells, asks, teaches: teachable(content, c.skills) };
}

/** 한 줄씩 (비어 있는 것은 뺀다) */
export function personFactLines(f: PersonFacts): string[] {
  return [
    ...(f.sells.length ? [`파는 물건: ${f.sells.join(", ")}`] : []),
    ...(f.asks.length ? [`꺼낼 부탁: ${f.asks.join(", ")}`] : []),
    ...(f.teaches.length ? [`가르칠 수 있는 것: ${f.teaches.join(", ")} (take_action.lesson)`] : []),
  ];
}
