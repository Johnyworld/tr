/**
 * 공통 규칙 25: 필수품 (docs/design.md "공통 규칙", 12-357, docs/junk-items-plan.md).
 *
 * 그 일을 하려면 있어야 하는 물건. 물건은 serves로 일(scenario.needs의 id)을 단다.
 * 있으면 보정 없이 보통으로 하고, 없으면 without이 null이면 못 하고 수이면 그만큼 판정 보정을 받는다.
 * 필수품은 스킬 보정을 주지 않는다 (사용자 결정 2026-11-27: 밧줄은 오르는 데 보태는 게 아니라 오르기 위한 물건이다).
 * 쓸 때 닳는 물건(라이터·성냥갑)은 내구도가 닳아 다 쓰면 없어지고, consume인 일(물 거르기)은 하나씩 쓴다.
 * 일의 목록과 물건은 시나리오 데이터다 (원칙 7). 새로 물건이 있어야 하는 일이 생기면 needs에 id를 더하고, 코드는 이 모듈로만 묻는다
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { heldInventory, takeOut } from "./bags.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { josa } from "../text.ts";

export type NeedDef = Content["scenario"]["needs"][number];
type Part = { label: string; value: number };

export function needDef(content: Pick<Content, "scenario">, need: string): NeedDef | undefined {
  return content.scenario.needs.find((n) => n.id === need);
}

/** GM이 판정에 붙이는 일 (check.needs) */
export function checkNeedIds(content: Pick<Content, "scenario">): string[] {
  return content.scenario.needs.filter((n) => n.check).map((n) => n.id);
}

/** 이 일에 쓰는 물건들 (콘텐츠 순서) */
export function needItems(content: Pick<Content, "items">, need: string): string[] {
  return Object.entries(content.items)
    .filter(([, item]) => item.serves?.includes(need))
    .map(([id]) => id);
}

type Holder = Pick<GameState, "characters" | "bags">;

/** 이 사람이 지닌 그 일의 물건 (없으면 null). 지닌 가방 속도 본다 (공통 규칙 26). 여럿이면 콘텐츠 순서로 먼저 것 */
export function needItem(content: Pick<Content, "items">, state: Holder, who: string, need: string): string | null {
  if (!state.characters[who]) return null;
  const held = heldInventory(state, who);
  return needItems(content, need).find((id) => (held[id] ?? 0) > 0) ?? null;
}

function itemNames(content: Pick<Content, "items">, need: string): string {
  return needItems(content, need)
    .map((id) => content.items[id]?.name ?? id)
    .join("·");
}

/** 물건이 없을 때 보정 줄의 이름 */
function withoutLabel(content: Pick<Content, "items">, def: NeedDef): string {
  return def.without_label ?? `${itemNames(content, def.id) || def.label} 없이`;
}

export type NeedCheck = { ok: true; item: string | null; parts: Part[] } | { ok: false; error: string };

/**
 * 이 일을 할 수 있는가: 물건이 있으면 보정 없이, 없으면 without 보정 또는 못 한다.
 * move가 정해진 일은 없이 할 때 그 스킬로만 판정한다 (불을 비벼 피우는 것은 생존)
 */
export function checkNeed(content: Pick<Content, "scenario" | "items">, state: Holder, who: string, need: string, move?: string | null): NeedCheck {
  const def = needDef(content, need);
  if (!def) return { ok: false, error: `알 수 없는 일: ${need}` };
  const item = needItem(content, state, who, need);
  if (item) return { ok: true, item, parts: [] };
  const names = itemNames(content, need);
  if (def.without === null) return { ok: false, error: `${def.label}에는 ${names || "물건"} 중 하나가 있어야 한다. 지닌 것이 없다.` };
  if (def.move && move !== undefined && move !== def.move) {
    return { ok: false, error: `${names || "물건"} 없이 ${def.label}는 ${def.move} 판정으로 한다 (check.move: ${def.move}).` };
  }
  return { ok: true, item: null, parts: [{ label: withoutLabel(content, def), value: def.without }] };
}

/** 없이 할 때 더 드는 시간 (분) */
export function needExtraMinutes(content: Pick<Content, "scenario">, need: string): number {
  return needDef(content, need)?.minutes ?? 0;
}

/**
 * 물건을 한 번 쓴다: consume인 일은 하나 없어지고, 내구도가 있으면 하나 닳아 다 닳으면 없어진다 (손질로 아끼지 않는다).
 * 다 써서 없어졌으면 그 한 줄
 */
export function useNeedItem(ctx: ToolContext, holder: string, need: string, itemId: string): string[] {
  const { store, content } = ctx;
  const item = content.items[itemId];
  if (!item) return [];
  const consume = !!needDef(content, need)?.consume;
  if (!consume && !item.durability) return [];
  // 가방 속이면 꺼내 쓰고 남은 것은 다시 넣는다 (공통 규칙 26)
  const pulled = takeOut(ctx, holder, itemId, 1, item.breaks_into ?? null);
  const lines = [...pulled.lines];
  if (consume) store.append({ type: "item_consumed", holder, itemId, quantity: 1 });
  else {
    store.append({ type: "item_worn", characterId: holder, itemId, delta: 1 });
    const wear = store.getState().characters[holder]?.wear[itemId] ?? 0;
    if (wear >= item.durability!) {
      store.append({ type: "item_broken", characterId: holder, itemId, into: item.breaks_into ?? null });
      lines.push(`${josa(item.name, "을/를")} 다 썼다.`);
    }
  }
  return [...lines, ...pulled.restore()];
}

/** GM 안내: 판정에 붙이는 일과 물건 (도구 설명) */
export function checkNeedsGuide(scenario: Content["scenario"]): string {
  const defs = scenario.needs.filter((n) => n.check);
  if (!defs.length) return "이 월드에는 없다. null";
  return (
    "그 일을 하려면 물건이 있어야 하는 판정이면 고른다 (필수품, 보정은 없고 없으면 불리하거나 못 한다): " +
    defs.map((d) => `${d.id} ${d.label}(${d.without === null ? "없으면 못 함" : `없으면 ${d.without}`})`).join(", ") +
    ". 아니면 null"
  );
}
