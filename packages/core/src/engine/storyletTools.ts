import { changeCondition } from "./body.ts";
import { disposition } from "../sim/war.ts";
import { createExtraCharacter } from "./extras.ts";
import { EXTRA_CAST_PREFIX } from "../story/storylets.ts";
import { joinRole } from "../game/customStart.ts";
import { z } from "zod";
import { playerCalls } from "../game/acquaintance.ts";
import { withCharm } from "./charm.ts";
import { enterScene } from "./extras.ts";
import { gainMeritXp } from "./growth.ts";
import type { Content, StoryletContent, StoryletEffect } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { GameState } from "../game/state.ts";
import { DEED_TAG_LABELS, RELATION_AXIS_LABELS } from "../game/reputation.ts";
import { CHECK_OUTCOME_LABELS, type CheckOutcome } from "../rules/check.ts";
import { moveLabel } from "../scenario/scenario.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import {
  eligibleStorylets,
  fillStorylet,
  pickCast,
  pickStorylet,
  storyletVars,
  storyletWindowOpen,
} from "../story/storylets.ts";
import { josa, sentence } from "../text.ts";
import { recordDeed } from "./reputationTools.ts";
import { commanderOf } from "../game/missions.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 스토리렛 연결 (기획서 10.3).
 * - 시간이 흐른 뒤: 진행 중인 것이 오래되면 지나가고, 간격이 지났으면 조건이 맞는 것 하나를 연다
 * - GM은 상태의 "진행 중인 이야기"를 연출하고, 플레이어의 선택이 분명해지면 resolve_storylet으로 알린다
 * - 효과는 콘텐츠가 정한 것만 코드가 적용한다 (원칙 2)
 */

/**
 * 진행 중인 이야기를 끝낸다 (시간이 지났거나, 자리를 떴거나, 전투가 벌어졌을 때).
 * 이야기 때문에 들어온 배역은 장면을 떠난다
 */
export function endActiveStorylet(ctx: ToolContext, reason: string): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const active = store.getState().activeStorylet;
  if (!active) return [];
  const s = content.storylets[active.id];
  store.append({ type: "storylet_expired", storyletId: active.id });
  const displays: ToolDisplayEvent[] = [];
  for (const [key, id] of Object.entries(active.cast)) {
    if (!s?.cast[key]?.enter || !store.getState().scene.present.includes(id)) continue;
    store.append({ type: "npc_left", npcId: id });
    displays.push({ type: "presence", npcName: playerCalls(store.getState(), content, id), action: "leave" });
  }
  if (s) displays.push({ type: "storylet", event: "expired", title: s.title, detail: reason });
  return displays;
}

export function runStorylets(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const displays: ToolDisplayEvent[] = [];
  let state = store.getState();
  if (state.activeStorylet && state.time >= state.activeStorylet.expiresAt) {
    displays.push(...endActiveStorylet(ctx, "지나갔다"));
    state = store.getState();
  }
  const player = state.characters[state.playerId];
  if (!player || player.dead || !storyletWindowOpen(state, content, state.time)) return displays;
  // 고정 이야기(한 번뿐인 것)가 열릴 수 있으면 먼저 연다. 반복되는 템플릿에 밀려 묻히지 않게
  const eligible = eligibleStorylets(state, content);
  const fixed = eligible.filter((s) => !s.repeatable);
  const storylet = pickStorylet(fixed.length ? fixed : eligible, rng);
  if (!storylet) return displays;
  const cast = pickCast(state, content, storylet, rng)!;
  // 이름 없는 인물 배역: 틀로 캐릭터를 만든다 (능력·소지품은 틀에서 굴린다)
  for (const [key, id] of Object.entries(cast)) {
    if (!id.startsWith(EXTRA_CAST_PREFIX)) continue;
    const template = content.extras[id.slice(EXTRA_CAST_PREFIX.length)]!;
    const now = store.getState();
    const extraId = `ex_${now.nextExtraNo}`;
    const usedNames = new Set(Object.values(now.characters).map((c) => c.name));
    const label = storylet.cast[key]?.label ?? template.label;
    store.append({ type: "extra_spawned", character: createExtraCharacter(content, template, { id: extraId, label, zone: now.playerZone, time: now.time, usedNames }, rng) });
    cast[key] = extraId;
  }
  store.append({
    type: "storylet_fired",
    storyletId: storylet.id,
    cast,
    expiresAt: state.time + Math.round(content.scenario.storylet_pacing.expire_hours * 60),
  });
  // 배역은 장면에 들어온다
  for (const [key, id] of Object.entries(cast)) {
    if (!storylet.cast[key]?.enter) continue;
    const now = store.getState();
    if (now.scene.present.includes(id) || now.characters[id]?.dead || now.characters[id]?.away) continue;
    enterScene(ctx, id);
    displays.push({ type: "presence", npcName: playerCalls(store.getState(), content, id), action: "enter" });
  }
  displays.push({ type: "storylet", event: "started", title: storylet.title, detail: setupText(store.getState(), content) });
  return displays;
}

/** 빨리감기 중 스토리렛이 열릴 수 있게 되면 멈춘다 */
export function createStoryletCheck(content: Content, options: { asleep?: boolean } = {}): InterruptCheck {
  return ({ state, to }) => {
    if (Object.keys(content.storylets).length === 0) return null;
    if (!storyletWindowOpen(state, content, to)) return null;
    // 자는 동안에는 급한 일만 깨운다 (나머지는 깬 뒤에 열린다)
    const eligible = eligibleStorylets(state, content, to).filter((s) => !options.asleep || s.urgent);
    return eligible.length > 0 ? { kind: "storylet", detail: "일이 생겼다", at: to } : null;
  };
}

function activeOf(state: GameState, content: Content): { storylet: StoryletContent; cast: Record<string, string> } | null {
  const active = state.activeStorylet;
  const storylet = active ? content.storylets[active.id] : undefined;
  return active && storylet ? { storylet, cast: active.cast } : null;
}

function setupText(state: GameState, content: Content): string {
  const a = activeOf(state, content);
  if (!a) return "";
  return fillStorylet(a.storylet.setup, storyletVars(state, content, a.cast));
}

/** GM 컨텍스트: 진행 중인 이야기. 조건(클락 등)은 넣지 않는다 */
export function describeStoryletForGm(state: GameState, content: Content): string {
  const a = activeOf(state, content);
  if (!a) return "";
  const vars = storyletVars(state, content, a.cast);
  const lines = [
    `진행 중인 이야기: ${a.storylet.title}`,
    `  상황: ${fillStorylet(a.storylet.setup, vars)}`,
    ...(a.storylet.ai_direction ? [`  [GM 전용] 연출: ${fillStorylet(a.storylet.ai_direction, vars)}`] : []),
    `  등장: ${Object.entries(a.cast).map(([k, id]) => `${k}=${vars[k]}(${id})`).join(", ") || "없음"}`,
    `  선택지 (resolve_storylet): ${a.storylet.choices
      .map((c) => `${c.id} ${fillStorylet(c.label, vars)}${c.check ? ` [먼저 take_action에서 ${moveLabel(content.scenario, c.check)}(${c.check}) 판정]` : ""}`)
      .join(" / ")}`,
    "  이 상황을 장면으로 연출하고, 플레이어가 어느 쪽을 택했는지 분명해지면 resolve_storylet을 호출한다. 결과(효과)를 미리 말하거나 지어내지 않는다. 플레이어가 외면하면 그대로 둔다 (시간이 지나면 지나간다).",
  ];
  return lines.join("\n");
}

export const resolveStorylet = defineTool({
  name: "resolve_storylet",
  description:
    "진행 중인 이야기(상태의 '진행 중인 이야기')에서 플레이어가 고른 선택지를 알린다. 효과는 시스템이 적용한다. " +
    "판정이 붙은 선택지는 같은 턴에 take_action으로 그 판정을 먼저 한 뒤 호출한다. 플레이어의 행동이 어느 선택지에도 맞지 않으면 호출하지 않는다.",
  schema: z.strictObject({ choice_id: z.string().describe("선택지 id") }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const a = activeOf(state, ctx.content);
    if (!a) return { ok: false, error: "진행 중인 이야기가 없다." };
    const choice = a.storylet.choices.find((c) => c.id === input.choice_id);
    if (!choice) return { ok: false, error: `없는 선택지: ${input.choice_id} (가능: ${a.storylet.choices.map((c) => c.id).join(", ")})` };
    let outcome: CheckOutcome | null = null;
    let effects = choice.effects;
    if (choice.check) {
      // 이번 턴 그 행동의 판정 결과로 갈린다
      const check = Object.values(state.checks)
        .filter((c) => c.turn === state.turn && c.actorId === state.playerId && c.move === choice.check)
        .at(-1);
      if (!check) {
        return { ok: false, error: `이 선택지는 이번 턴 take_action에서 ${moveLabel(ctx.content.scenario, choice.check)}(${choice.check}) 판정을 먼저 해야 한다.` };
      }
      outcome = check.outcome;
      effects = choice.outcomes![check.outcome];
    }
    // 내놓을 물건이 없으면 고를 수 없다 (거래 선택지)
    const player = state.characters[state.playerId]!;
    for (const e of effects) {
      if ("take_item" in e && (player.inventory[e.take_item.item] ?? 0) < e.take_item.quantity) {
        const name = ctx.content.items[e.take_item.item]?.name ?? e.take_item.item;
        return { ok: false, error: `${josa(`${name} ×${e.take_item.quantity}`, "이/가")} 없어 이 선택지를 고를 수 없다. 다른 선택지를 고르거나 그대로 둔다.` };
      }
    }
    const vars = storyletVars(state, ctx.content, a.cast);
    ctx.store.append({ type: "storylet_resolved", storyletId: a.storylet.id, choiceId: choice.id, outcome });
    const lines: string[] = [`이야기 "${a.storylet.title}": ${fillStorylet(choice.label, vars)}${outcome ? ` (${CHECK_OUTCOME_LABELS[outcome]})` : ""}.`];
    const extra: ToolDisplayEvent[] = [];
    for (const effect of effects) {
      const r = applyEffect(ctx, effect, a.cast, vars, a.storylet.title);
      if (r.line) lines.push(r.line);
      if (r.display) extra.push(r.display);
    }
    lines.push("이 결과에 맞게 이야기를 마무리하는 장면을 서술하라.");
    return {
      ok: true,
      resultText: lines.join("\n"),
      display: { type: "storylet", event: "resolved", title: a.storylet.title, detail: fillStorylet(choice.label, vars) },
      extra,
    };
  },
});

function whoOf(ctx: ToolContext, who: string, cast: Record<string, string>): string | null {
  if (cast[who]) return cast[who]!;
  if (who === "commander") return commanderOf(ctx.store.getState(), ctx.content);
  return null;
}

/** 효과 하나를 적용한다. GM에게 돌려줄 한 줄 */
function applyEffect(
  ctx: ToolContext,
  effect: StoryletEffect,
  cast: Record<string, string>,
  vars: Record<string, string>,
  reason: string,
): { line?: string; display?: ToolDisplayEvent } {
  const { store, content } = ctx;
  const state = store.getState();
  const playerId = state.playerId;
  if ("set_flag" in effect) {
    store.append({ type: "flag_set", characterId: playerId, flag: effect.set_flag });
    return {};
  }
  if ("clear_flag" in effect) {
    store.append({ type: "flag_cleared", characterId: playerId, flag: effect.clear_flag });
    return {};
  }
  if ("relation" in effect) {
    const from = whoOf(ctx, effect.relation.who, cast);
    if (!from || !state.characters[from]) return {};
    const delta = withCharm(ctx, from, playerId, { trust: 0, affection: 0, respect: 0, [effect.relation.axis]: effect.relation.delta });
    store.append({ type: "relation_changed", from, to: playerId, delta, reason });
    const name = playerCalls(state, content, from);
    return { line: `${name}의 ${josa(RELATION_AXIS_LABELS[effect.relation.axis], "이/가")} ${effect.relation.delta > 0 ? "올랐다" : "떨어졌다"}. 그 인물의 태도에 반영하라.` };
  }
  if ("belief" in effect) {
    const fact = sentence(fillStorylet(effect.belief.fact, vars));
    store.append({
      type: "belief_added",
      characterId: playerId,
      belief: { id: `b_${state.nextBeliefNo}`, fact, source: effect.belief.source, accuracy: "approximate", learnedAt: state.time },
    });
    return { line: `알게 된 것: ${fact}`, display: { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[effect.belief.source] } };
  }
  if ("merit" in effect) {
    store.append({ type: "merit_awarded", characterId: playerId, delta: effect.merit, reason });
    const growthNote = gainMeritXp(ctx, playerId, effect.merit);
    return { line: `공적 ${effect.merit > 0 ? "+" : ""}${effect.merit}.` + (growthNote ? ` ${growthNote}` : "") };
  }
  if ("give_item" in effect) {
    const { item, quantity } = effect.give_item;
    const name = content.items[item]?.name ?? item;
    if (effect.give_item.from) {
      const holder = whoOf(ctx, effect.give_item.from, cast);
      const have = holder ? (state.characters[holder]?.inventory[item] ?? 0) : 0;
      if (!holder || have < quantity) return { line: `${name}은(는) 건네받을 수 없었다 (가진 것이 없다).` };
      store.append({ type: "item_transferred", from: holder, to: playerId, itemId: item, quantity });
      const fromName = playerCalls(state, content, holder);
      return { line: `${josa(fromName, "이/가")} ${josa(`${name} ×${quantity}`, "을/를")} 건넸다.`, display: { type: "item", fromName, toName: state.characters[playerId]!.name, itemName: name, quantity } };
    }
    store.append({ type: "item_granted", to: playerId, itemId: item, quantity });
    return { line: `${josa(`${name} ×${quantity}`, "을/를")} 얻었다.`, display: { type: "item", fromName: "", toName: state.characters[playerId]!.name, itemName: name, quantity } };
  }
  if ("take_item" in effect) {
    const { item, quantity } = effect.take_item;
    store.append({ type: "item_consumed", holder: playerId, itemId: item, quantity });
    return { line: `${josa(`${content.items[item]?.name ?? item} ×${quantity}`, "을/를")} 내주었다.` };
  }
  if ("clock" in effect) {
    if (!state.clocks[effect.clock.id]) return {};
    store.append({ type: "clock_adjusted", clockId: effect.clock.id, delta: effect.clock.delta });
    return {}; // 세력 클락은 아무도 모른다. 결과만 세계에 남는다
  }
  if ("faction_morale" in effect) {
    const id = effect.faction_morale.faction === "own" ? state.characters[playerId]!.factionId : effect.faction_morale.faction;
    if (!state.factions[id]) return {};
    store.append({ type: "faction_morale_changed", factionId: id, delta: effect.faction_morale.delta });
    return {};
  }
  if ("faction_relation" in effect) {
    const own = state.characters[playerId]!.factionId;
    const id = (x: string) => (x === "own" ? own : x);
    const { delta, mutual } = effect.faction_relation;
    const pairs = [[id(effect.faction_relation.from), id(effect.faction_relation.to)]];
    if (mutual) pairs.push([pairs[0]![1]!, pairs[0]![0]!]);
    for (const [from, to] of pairs) {
      if (!from || !to || from === to || !state.factions[from] || !content.factions[to]) continue;
      const now = disposition(content, from, to, store.getState());
      const value = Math.max(-3, Math.min(3, now + delta));
      if (value !== now) store.append({ type: "faction_disposition_changed", from, to, value });
    }
    return {}; // 무리 사이 분위기는 소문과 전황으로만 드러난다
  }
  if ("body" in effect) {
    const { track, delta } = effect.body;
    if (track === content.scenario.harm_track) return {};
    const t = content.scenario.condition_tracks.find((x) => x.id === track);
    const player = state.characters[playerId]!;
    if (!t) return {};
    // 마지막 단계(죽음)까지는 가지 않는다
    const index = t.levels.findIndex((l) => l.id === player.conditions[track]);
    const last = t.levels.findIndex((l) => l.fatal);
    const limit = (last >= 0 ? last : t.levels.length) - 1;
    const steps = delta > 0 ? Math.min(delta, Math.max(0, limit - index)) : delta;
    const change = changeCondition(ctx, playerId, track, steps, "이야기", reason);
    return change && change.line ? { line: change.line, display: change.display ?? undefined } : {};
  }
  if ("faction_resource" in effect) {
    const { resource, delta } = effect.faction_resource;
    const id = effect.faction_resource.faction === "own" ? state.characters[playerId]!.factionId : effect.faction_resource.faction;
    if (!state.factions[id]) return {};
    store.append({ type: "faction_resource_changed", factionId: id, resource, delta });
    return {}; // 창고 사정은 배급과 소문으로만 드러난다
  }
  if ("join_faction" in effect) {
    const player = state.characters[playerId]!;
    const { faction, rank, title } = effect.join_faction;
    if (!content.factions[faction] || player.factionId === faction) return {};
    const from = player.factionId ? (content.roles[state.roleId]?.label ?? content.factions[player.factionId]?.name ?? "") : "무소속";
    const role = joinRole(content, faction, rank, { age: player.age, title });
    // 그 무리에서 처음 듣는 사정: 같은 계급 시나리오의 시작 지식 (다른 계급의 지식은 주지 않는다)
    const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
    let no = state.nextBeliefNo;
    const beliefs = (preset?.beliefs ?? []).map((b) => ({ id: `b_${no++}`, fact: b.fact, source: b.source === "seen" ? ("report" as const) : b.source, accuracy: b.accuracy, learnedAt: state.time }));
    store.append({ type: "player_joined_faction", factionId: faction, rank: role.rank, role, beliefs });
    const commander = role.commander ? state.characters[role.commander]?.name : undefined;
    return {
      line:
        `${content.factions[faction]!.name}에 들어갔다 (${role.label}).${commander ? ` 상관은 ${commander}.` : ""} 이제 이 무리의 배급과 임무를 받는다.` +
        (player.factionId ? ` 전에 있던 무리(${content.factions[player.factionId]?.name ?? player.factionId})의 사람들은 이제 남이다.` : "") +
        (beliefs.length ? ` 이 무리 사정을 ${beliefs.length}가지 들었다 (상태의 믿음).` : ""),
      display: { type: "promotion", name: player.name, fromLabel: from, toLabel: role.label },
    };
  }
  if ("npc_depart" in effect) {
    const id = whoOf(ctx, effect.npc_depart.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || npc.away) return {};
    const to = effect.npc_depart.to_faction ?? null;
    store.append({ type: "npc_departed", npcId: id, toFaction: to });
    const name = playerCalls(state, content, id);
    return {
      line: to ? `${josa(name, "은/는")} ${content.factions[to]?.name ?? to} 쪽으로 넘어갔다.` : `${josa(name, "은/는")} 도시를 떠났다. 다시 장면에 나오지 않는다.`,
      display: { type: "presence", npcName: name, action: "leave" },
    };
  }
  if ("deed" in effect) {
    const { deed, visible } = recordDeed(ctx, { ...effect.deed, summary: fillStorylet(effect.deed.summary, vars), noisy: false });
    return {
      line: `행적 기록: ${sentence(deed.summary)}${visible.length ? ` 본 사람: ${visible.join(", ")}.` : ""}`,
      display: { type: "deed", summary: deed.summary, tagLabels: deed.tags.map((t) => DEED_TAG_LABELS[t]), visibleWitnesses: visible },
    };
  }
  return {};
}

export const STORYLET_TOOLS = [resolveStorylet] as const;
