import { preservesHere } from "./facilities.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { seasonAt } from "../sim/season.ts";
import { josa } from "../text.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 먹고 마시기 (기획서 4.5.5, 12-131): 사냥·낚시, 덫, 음식이 상하는 것, 끓이지 않은 물.
 * 무엇을 얼마나 얻는지·상하는지·병에 걸리는지는 코드가 정한다 (원칙 2). 종류와 수치는 시나리오 foraging·spoilage·아이템 데이터
 */

type Result = { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string };

/** 지금 구역에 불이 피어 있다 (끓여 마실 수 있다) */
export function fireHere(state: ReturnType<ToolContext["store"]["getState"]>): boolean {
  const zone = state.playerZone;
  return !!zone && (state.fires[zone] ?? 0) > state.time;
}

/** 물이 나는 구역인가 (갈증 자원이 나는 곳) */
function watery(ctx: ToolContext, zone: string): boolean {
  const resource = ctx.content.scenario.body?.thirst?.resource;
  return !!resource && (ctx.content.locations[zone]?.yields[resource] ?? 0) > 0;
}

/** 먹을 것을 구한다 (take_action.forage). 판정 결과만큼 굴린다 */
export function forage(ctx: ToolContext, kindId: string, outcome: CheckOutcome | null): Result {
  const { store, content, rng } = ctx;
  const rules = content.scenario.foraging;
  const kind = rules?.kinds.find((k) => k.id === kindId);
  if (!rules || !kind) return { ok: false, error: `알 수 없는 일: ${kindId} (가능: ${rules?.kinds.map((k) => k.id).join(", ") ?? "없음"})` };
  const state = store.getState();
  const zone = state.playerZone;
  if (!zone) return { ok: false, error: "어디에 있는지 모른다." };
  if (kind.water && !watery(ctx, zone)) return { ok: false, error: `여기는 물가가 아니라 ${josa(kind.label, "을/를")} 할 수 없다.` };
  if (!kind.water && content.locations[zone]?.kind === "base") return { ok: false, error: `거점 안에서는 ${josa(kind.label, "을/를")} 할 수 없다. 담 밖으로 나간다.` };

  // 같은 날 같은 곳에서 다시 할수록 덜 잡힌다 (수색과 같은 기록을 일마다 따로 쓴다)
  const key = `${zone}#${kind.id}`;
  const day = dayOf(state.time);
  const before = state.zoneSearches[key];
  const count = before && before.day === day ? before.count : 0;
  store.append({ type: "zone_searched", zone: key, day });

  // 함께 다니는 개가 몰이를 돕는다: 한 번 더 굴린다
  const helper = state.companions.find((id) => {
    const c = state.characters[id];
    return c && !c.dead && !!c.extra && kind.companions.includes(c.extra.template);
  });
  let rolls = outcome === "success" ? 2 : outcome === "partial" ? 1 : outcome === "miss" ? 0 : 1;
  if (helper && outcome !== "miss") rolls += 1;
  const chance = kind.chance * 0.5 ** count * (outcome === null ? 0.5 : 1);
  const total = kind.items.reduce((n, i) => n + i.weight, 0);
  const found = new Map<string, number>();
  for (let r = 0; r < rolls; r++) {
    if (rng() >= chance) continue;
    let pick = rng() * total;
    const entry = kind.items.find((i) => (pick -= i.weight) < 0) ?? kind.items[kind.items.length - 1]!;
    const qty = entry.qty[0] + Math.floor(rng() * (entry.qty[1] - entry.qty[0] + 1));
    found.set(entry.item, (found.get(entry.item) ?? 0) + qty);
  }
  const me = state.characters[state.playerId]!;
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  const names: string[] = [];
  for (const [item, quantity] of found) {
    store.append({ type: "item_granted", to: me.id, itemId: item, quantity });
    const itemName = content.items[item]?.name ?? item;
    names.push(`${itemName} ×${quantity}`);
    displays.push({ type: "item", fromName: "", toName: me.name, itemName, quantity });
  }
  const tired = count > 0 ? " 오늘 이미 한 곳이라 덜 잡힌다." : "";
  const dog = helper ? ` ${josa(state.characters[helper]!.name, "이/가")} 몰이를 도왔다.` : "";
  lines.push(
    names.length
      ? `${kind.label}: ${josa(names.join(", "), "을/를")} 얻었다 (소지품에 들어왔다). 얻은 것만 서술한다.${dog}${tired}`
      : `${kind.label}: 아무것도 얻지 못했다.${tired} 빈손인 것을 서술한다.`,
  );
  const perishable = [...found.keys()].filter((i) => content.items[i]?.perishable);
  if (perishable.length) lines.push("날것은 며칠 안에 상한다. 먹거나 말리거나 훈연한다 (craft).");
  return { ok: true, lines, displays };
}

/** 덫을 놓거나(set) 거둔다(check) (take_action.trap) */
export function handleTrap(ctx: ToolContext, action: "set" | "check"): Result {
  const { store, content } = ctx;
  const trap = content.scenario.foraging?.trap;
  if (!trap) return { ok: false, error: "이 월드에는 덫 규칙이 없다." };
  const state = store.getState();
  const zone = state.playerZone;
  if (!zone) return { ok: false, error: "어디에 있는지 모른다." };
  const me = state.characters[state.playerId]!;
  const here = state.traps.find((t) => t.zone === zone);
  const trapName = content.items[trap.item]?.name ?? trap.item;
  if (action === "set") {
    if (here) return { ok: false, error: "이 구역에는 이미 덫을 놓았다. 먼저 거둔다 (trap: check)." };
    if (content.locations[zone]?.kind === "base") return { ok: false, error: "거점 안에는 덫을 놓을 데가 없다." };
    if ((me.inventory[trap.item] ?? 0) < 1) return { ok: false, error: `${josa(trapName, "이/가")} 없다.` };
    store.append({ type: "item_consumed", holder: me.id, itemId: trap.item, quantity: 1 });
    store.append({ type: "trap_set", zone, at: state.time });
    return { ok: true, lines: [`${josa(trapName, "을/를")} 감아 덫을 놓았다. 하루가 지나면 무언가 걸려 있을 수 있다. 다시 와서 거둔다.`], displays: [] };
  }
  if (!here) return { ok: false, error: "이 구역에 놓아 둔 덫이 없다." };
  store.append({ type: "trap_collected", zone });
  store.append({ type: "item_granted", to: me.id, itemId: trap.item, quantity: 1 });
  const lines = [`덫을 거뒀다 (${josa(trapName, "은/는")} 다시 소지품으로).`];
  const displays: ToolDisplayEvent[] = [];
  if (here.caught) {
    store.append({ type: "item_granted", to: me.id, itemId: here.caught, quantity: here.qty });
    const itemName = content.items[here.caught]?.name ?? here.caught;
    lines.push(`덫에 걸린 것: ${itemName} ×${here.qty}. 걸린 것만 서술한다.`);
    displays.push({ type: "item", fromName: "", toName: me.name, itemName, quantity: here.qty });
  } else lines.push("아무것도 걸리지 않았다. 빈 덫을 서술한다.");
  return { ok: true, lines, displays };
}

/** 하루가 지날 때: 빈 덫에 무언가 걸리고, 날것이 상한다 */
export function runDailyFood(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const trap = content.scenario.foraging?.trap;
  if (trap) {
    for (const t of store.getState().traps) {
      if (t.caught || rng() >= trap.chance) continue;
      const qty = trap.catch.qty[0] + Math.floor(rng() * (trap.catch.qty[1] - trap.catch.qty[0] + 1));
      store.append({ type: "trap_caught", zone: t.zone, item: trap.catch.item, qty });
    }
  }
  // 날것이 상한다: 하나하나가 perishable × 계절 배수의 확률로
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return [];
  // 훈제 막 (12-167): 그곳에서 날을 넘기면 날것이 상하지 않는다
  if (preservesHere(content, state)) return [];
  const season = seasonAt(content.scenario, state.time)?.id ?? "";
  const factor = content.scenario.spoilage?.season[season] ?? 1;
  const spoiled: string[] = [];
  for (const [item, n] of Object.entries(me.inventory)) {
    const p = Math.min(1, (content.items[item]?.perishable ?? 0) * factor);
    if (!p || n <= 0) continue;
    let lost = 0;
    for (let i = 0; i < n; i++) if (rng() < p) lost++;
    if (!lost) continue;
    store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: lost });
    spoiled.push(`${content.items[item]?.name ?? item} ${lost}개`);
  }
  if (!spoiled.length) return [];
  const fact = `상해서 버렸다: ${spoiled.join(", ")}`;
  return [{ type: "belief", fact, sourceLabel: "소지품", note: `${fact}. 상한 냄새를 서술에 비춘다` }];
}

/**
 * 끓이지 않은 물을 마셨다: chance로 병에 걸린다 (잠복부터, 그 사람은 모른다).
 * 불이 피어 있으면 끓여 마셔 괜찮다. 이미 앓고 있으면 그대로
 */
export function drinkDirty(ctx: ToolContext, chance: number): string | null {
  const state = ctx.store.getState();
  if (fireHere(state)) return "불에 끓여 마셨다.";
  const track = ctx.content.scenario.body?.disease?.track;
  const me = state.characters[state.playerId]!;
  if (!track || ctx.rng() >= chance) return null;
  const levels = ctx.content.scenario.condition_tracks.find((t) => t.id === track)?.levels ?? [];
  if (levels.findIndex((l) => l.id === me.conditions[track]) > 0) return null;
  changeCondition(ctx, me.id, track, 1, "water", "끓이지 않은 물");
  return null;
}
