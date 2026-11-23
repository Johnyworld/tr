import { ableNow } from "../rules/company.ts";
import { fireLitHere } from "../rules/place.ts";
import { preservesHere } from "./facilities.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { foundCount, searchedToday } from "./scavenge.ts";
import { seasonAt } from "../sim/season.ts";
import { josa } from "../text.ts";
import { moveLabel } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { learned } from "../rules/skill.ts";

/**
 * 먹고 마시기 (기획서 4.5.5, 12-131): 사냥·낚시, 덫, 음식이 상하는 것, 끓이지 않은 물.
 * 무엇을 얼마나 얻는지·상하는지·병에 걸리는지는 코드가 정한다 (원칙 2). 종류와 수치는 시나리오 foraging·spoilage·아이템 데이터
 */

type Result = { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string };

/** 지금 구역에 불이 피어 있다 (끓여 마실 수 있다) */
export function fireHere(state: ReturnType<ToolContext["store"]["getState"]>): boolean {
  return fireLitHere(state);
}

/** 물이 나는 구역인가 (갈증 자원이 나는 곳) */
function watery(ctx: ToolContext, zone: string): boolean {
  const resource = ctx.content.scenario.body?.thirst?.resource;
  return !!resource && (ctx.content.locations[zone]?.yields[resource] ?? 0) > 0;
}

/** 여기서 이 먹을 것 구하기를 할 수 없는 까닭 (판정·시간 전에 본다, 플레이 테스트 11). 할 수 있으면 null */
export function forageProblem(ctx: ToolContext, kindId: string): string | null {
  const { store, content } = ctx;
  const rules = content.scenario.foraging;
  const kind = rules?.kinds.find((k) => k.id === kindId);
  if (!rules || !kind) return `알 수 없는 일: ${kindId} (가능: ${rules?.kinds.map((k) => k.id).join(", ") ?? "없음"})`;
  const zone = store.getState().playerZone;
  if (!zone) return "어디에 있는지 모른다.";
  if (kind.water && !watery(ctx, zone)) return `여기는 물가가 아니라 ${josa(kind.label, "을/를")} 할 수 없다.`;
  if (!kind.water && content.locations[zone]?.kind === "base") return `거점 안에서는 ${josa(kind.label, "을/를")} 할 수 없다. 담 밖으로 나간다.`;
  return unlearned(ctx, kind.move ?? rules.move);
}

/** 그 일의 전문 기술을 배우지 않았으면 까닭 (4.2.1) */
function unlearned(ctx: ToolContext, move: string | undefined): string | null {
  if (!move) return null;
  const state = ctx.store.getState();
  if (learned(ctx.content.scenario, state.characters[state.playerId]!.skills, move) !== null) return null;
  return `${josa(moveLabel(ctx.content.scenario, move), "은/는")} 배우지 않아 할 수 없는 전문 기술이다. 익힌 사람에게 배운다 (take_action.lesson).`;
}

/** 덫을 놓을 수 없는 까닭 (판정·시간 전에 막는다) */
export function trapProblem(ctx: ToolContext, action: "set" | "check"): string | null {
  return action === "set" ? unlearned(ctx, ctx.content.scenario.foraging?.trap?.move) : null;
}

/** 먹을 것 구하기 판정의 상황 보정 (12-220): 그 일의 쉽고 어려움(kind.modifier), 오늘 같은 곳에서 다시 하는 만큼 - */
export function forageParts(ctx: ToolContext, kindId: string): { label: string; value: number }[] {
  const kind = ctx.content.scenario.foraging?.kinds.find((k) => k.id === kindId);
  const state = ctx.store.getState();
  if (!kind || !state.playerZone) return [];
  return [
    { label: kind.label, value: kind.modifier },
    { label: "다시 함", value: -searchedToday(state, `${state.playerZone}#${kind.id}`) },
  ].filter((p) => p.value !== 0);
}

/** 먹을 것을 구한다 (take_action.forage). 판정 결과만큼 얻는다 (성공 2, 대가 있는 성공 1, 실패·판정 없음 0, 12-220) */
export function forage(ctx: ToolContext, kindId: string, outcome: CheckOutcome | null): Result {
  const { store, content, rng } = ctx;
  const problem = forageProblem(ctx, kindId);
  if (problem) return { ok: false, error: problem };
  const rules = content.scenario.foraging!;
  const kind = rules.kinds.find((k) => k.id === kindId)!;
  const state = store.getState();
  const zone = state.playerZone!;

  // 같은 날 같은 곳에서 다시 할수록 판정이 어렵다 (forageParts. 수색과 같은 기록을 일마다 따로 쓴다)
  const key = `${zone}#${kind.id}`;
  const count = searchedToday(state, key);
  store.append({ type: "zone_searched", zone: key, day: dayOf(state.time) });

  // 함께 다니는 개가 몰이를 돕는다: 하나 더
  const helper = state.companions.find((id) => {
    const c = state.characters[id];
    return c && ableNow(state, ctx.content, id) && state.scene.present.includes(id) && !!c.extra && kind.companions.includes(c.extra.template);
  });
  let rolls = foundCount(outcome);
  if (helper && rolls > 0) rolls += 1;
  const total = kind.items.reduce((n, i) => n + i.weight, 0);
  const found = new Map<string, number>();
  for (let r = 0; r < rolls; r++) {
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
      : outcome === null
        ? `${kind.label}: 판정 없이는 아무것도 얻지 못했다. ${moveLabel(content.scenario, kind.move ?? rules.move)} 판정을 건다.`
        : `${kind.label}: 아무것도 얻지 못했다.${tired} 빈손인 것을 서술한다.`,
  );
  const perishable = [...found.keys()].filter((i) => content.items[i]?.perishable);
  if (perishable.length) lines.push("날것은 며칠 안에 상한다. 먹거나 말리거나 훈연한다 (craft).");
  return { ok: true, lines, displays };
}

/** 덫을 놓거나(set) 거둔다(check) (take_action.trap) */
export function handleTrap(ctx: ToolContext, action: "set" | "check", outcome: CheckOutcome | null = null): Result {
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
    // 판정을 걸고 실패하면 놓지 못한다 (플레이 테스트 12: 실패해도 성공과 같이 놓였다). 재료는 남는다
    if (outcome === "miss") return { ok: true, lines: [`덫을 제대로 놓지 못했다. 시간만 들었다 (${josa(trapName, "은/는")} 그대로 남았다). 실패한 것을 서술한다.`], displays: [] };
    store.append({ type: "item_consumed", holder: me.id, itemId: trap.item, quantity: 1 });
    // 놓는 판정이 걸리는 날을 정한다 (12-220): 성공이면 다음 날, 대가 있는 성공·판정 없음이면 이틀 뒤. 하루 더 늦는 덫은 놓은 때를 하루 뒤로 적는다
    const sloppy = outcome !== "success";
    store.append({ type: "trap_set", zone, at: state.time + (sloppy ? MINUTES_PER_DAY : 0) });
    return {
      ok: true,
      lines: [`${josa(trapName, "을/를")} 감아 덫을 놓았다. ${sloppy ? "자리가 썩 좋지는 않다. 짐승이 들려면 이틀은 지나야 한다." : "자리가 좋다. 하루가 지나면 걸려 있을 것이다."} 다시 와서 거둔다.`],
      displays: [],
    };
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

/** 하루가 지날 때: 놓은 지 하루가 지난 빈 덫에 걸리고 (12-220, 놓는 판정이 정한 날), 날것이 상한다 */
export function runDailyFood(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const trap = content.scenario.foraging?.trap;
  if (trap) {
    const today = dayOf(store.getState().time);
    for (const t of store.getState().traps) {
      if (t.caught || today - dayOf(t.setAt) < 1) continue;
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
