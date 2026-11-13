import { capturePlayer, releasePlayer } from "./captivity.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { TIE_LABELS, tieKnown, tiesOf } from "../game/ties.ts";
import { dayOf, formatTime } from "../rules/time.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import { disposition } from "../sim/war.ts";
import { createExtraCharacter } from "./extras.ts";
import { EXTRA_CAST_PREFIX } from "../story/storylets.ts";
import { joinRole } from "../game/customStart.ts";
import { z } from "zod";
import { playerCalls } from "../game/acquaintance.ts";
import { withCharm } from "./charm.ts";
import { enterScene } from "./extras.ts";
import { changeStanding, gainMeritXp } from "./growth.ts";
import type { Content, StoryletContent, StoryletEffect } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { GameState } from "../game/state.ts";
import { DEED_TAG_LABELS, RELATION_AXIS_LABELS } from "../game/reputation.ts";
import { CHECK_OUTCOME_LABELS, type CheckOutcome } from "../rules/check.ts";
import { moveLabel } from "../scenario/scenario.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import {
  choiceAvailable,
  eligibleStorylets,
  fillStorylet,
  pickCast,
  pickStorylet,
  roadStorylets,
  routeDanger,
  storyletVars,
  storyletWindow,
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
  const window = storyletWindow(state, content, state.time);
  if (!player || player.dead || window === "closed") return displays;
  // 고정 이야기(한 번뿐인 것)가 열릴 수 있으면 먼저 연다. 반복되는 템플릿에 밀려 묻히지 않게
  const eligible = eligibleStorylets(state, content).filter((s) => window === "open" || s.urgent);
  const fixed = eligible.filter((s) => !s.repeatable);
  const storylet = pickStorylet(fixed.length ? fixed : eligible, rng);
  if (!storylet) return displays;
  displays.push(...fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!));
  displays.push({ type: "storylet", event: "started", title: storylet.title, detail: setupText(store.getState(), content) });
  return displays;
}

/**
 * 이야기를 연다: 이름 없는 배역은 틀로 만들고, 발동을 기록하고, 배역을 장면에 들인다 (치트도 이것을 쓴다).
 * 시작 표시(storylet started)는 부르는 쪽이 붙인다
 */
export function fireStorylet(ctx: ToolContext, storylet: StoryletContent, picked: Record<string, string>): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const displays: ToolDisplayEvent[] = [];
  const cast = { ...picked };
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
  // 이름표로 기억해 둔다 (다음 이야기에서 recall로 다시 부른다)
  for (const [key, id] of Object.entries(cast)) {
    const keep = storylet.cast[key]?.keep;
    if (keep) store.append({ type: "extra_kept", key: keep, characterId: id });
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
    if (now.characters[id]?.captive && now.characters[id]!.captive!.zone !== now.playerZone) continue;
    enterScene(ctx, id);
    displays.push({ type: "presence", npcName: playerCalls(store.getState(), content, id), action: "enter" });
  }
  return displays;
}

/** 빨리감기 중 스토리렛이 열릴 수 있게 되면 멈춘다 */
export function createStoryletCheck(content: Content, options: { asleep?: boolean } = {}): InterruptCheck {
  return ({ state, to }) => {
    if (Object.keys(content.storylets).length === 0) return null;
    const window = storyletWindow(state, content, to);
    if (window === "closed") return null;
    // 자는 동안·이야기 사이 간격 안에는 급한 일만 (나머지는 그 뒤에 열린다)
    const eligible = eligibleStorylets(state, content, to).filter((s) => (!options.asleep && window === "open") || s.urgent);
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
      .filter((c) => choiceAvailable(state, c, a.cast))
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
    const open = a.storylet.choices.filter((c) => choiceAvailable(state, c, a.cast));
    if (!choice || !open.includes(choice)) return { ok: false, error: `고를 수 없는 선택지: ${input.choice_id} (가능: ${open.map((c) => c.id).join(", ")})` };
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
    // 시간이 더 걸렸으면 그동안의 세계를 돌린다 (배급, 소문, 전쟁, 몸)
    if (effects.some((e) => "delay" in e)) extra.push(...runAfterTimeAdvance(ctx));
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
  if ("npc_relation" in effect) {
    const { axis, delta, mutual } = effect.npc_relation;
    const a = whoOf(ctx, effect.npc_relation.from, cast);
    const b = whoOf(ctx, effect.npc_relation.to, cast);
    if (!a || !b || a === b || a === playerId || b === playerId || !state.characters[a] || !state.characters[b]) return {};
    const d = { trust: 0, affection: 0, respect: 0, [axis]: delta };
    store.append({ type: "relation_changed", from: a, to: b, delta: d, reason });
    if (mutual) store.append({ type: "relation_changed", from: b, to: a, delta: d, reason });
    return {}; // 둘 사이의 마음은 그들의 말과 태도로만 드러난다
  }
  if ("overhear" in effect) {
    const me = state.characters[playerId]!;
    const want = effect.overhear.faction;
    const progress = (f: string) => Math.max(0, ...Object.values(state.clocks).filter((c) => c.factionId === f).map((c) => c.filled / c.max));
    const pool = Object.keys(state.factions)
      .filter((f) => f !== me.factionId && content.factions[f]?.startable !== false)
      .filter((f) => want === "other" || (want === "enemy" ? !me.factionId || disposition(content, me.factionId, f, state) < 0 : f === want));
    const target = pool.sort((a, b) => progress(b) - progress(a) || a.localeCompare(b))[0];
    const clock = target ? Object.values(state.clocks).filter((c) => c.factionId === target).sort((a, b) => b.filled / b.max - a.filled / a.max)[0] : undefined;
    if (!target || !clock) return {};
    const ratio = clock.filled / clock.max;
    const stage = ratio >= 0.75 ? "거의 다 됐다" : ratio >= 0.4 ? "절반쯤 와 있다" : ratio > 0 ? "막 시작됐다" : "아직 말뿐이다";
    const fact = sentence(`${content.factions[target]?.name ?? target}이(가) 준비하는 일: ${clock.label}. ${stage}`);
    store.append({
      type: "belief_added",
      characterId: playerId,
      belief: { id: `b_${state.nextBeliefNo}`, fact, source: effect.overhear.source, accuracy: "approximate", learnedAt: state.time, topic: "war" },
    });
    return { line: `엿들은 것: ${fact}`, display: { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[effect.overhear.source] } };
  }
  if ("fortify" in effect) {
    const zone = state.playerZone;
    const me = state.characters[playerId]!;
    if (!zone || !me.factionId || state.zones[zone]?.owner !== me.factionId) return {};
    const before = state.zones[zone]?.fort ?? 0;
    store.append({ type: "zone_fortified", zone, delta: effect.fortify });
    const after = store.getState().zones[zone]?.fort ?? 0;
    if (after === before) return {};
    return { line: after > before ? `${content.locations[zone]?.name ?? zone}의 담이 단단해졌다. 습격을 받으면 더 버틴다.` : `${content.locations[zone]?.name ?? zone}의 담이 헐렸다.` };
  }
  if ("zone_noise" in effect) {
    if (!state.playerZone) return {};
    store.append({ type: "noise_made", zone: state.playerZone, level: effect.zone_noise, day: dayOf(state.time) });
    return { line: "소리가 났다. 이 구역에 무언가 몰려들 수 있다." };
  }
  if ("npc_hurt" in effect) {
    const id = whoOf(ctx, effect.npc_hurt.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || id === playerId) return {};
    // 죽음 바로 앞에서 멈춘다 (원칙 3)
    const track = harmTrack(content.scenario);
    const index = Math.max(0, track.levels.findIndex((l) => l.id === npc.conditions[track.id]));
    const fatal = track.levels.findIndex((l) => l.fatal);
    const limit = (fatal >= 0 ? fatal : track.levels.length) - 1;
    const steps = Math.min(effect.npc_hurt.steps, Math.max(0, limit - index));
    if (steps <= 0) return {};
    const change = changeCondition(ctx, id, track.id, steps, "이야기", reason);
    return change?.line && store.getState().scene.present.includes(id) ? { line: change.line, display: change.display ?? undefined } : {};
  }
  if ("npc_rank" in effect) {
    const id = whoOf(ctx, effect.npc_rank.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || id === playerId || npc.rank === effect.npc_rank.rank) return {};
    store.append({ type: "npc_rank_changed", npcId: id, rank: effect.npc_rank.rank });
    const label = content.scenario.rank_ladder.find((r) => r.id === effect.npc_rank.rank)?.label ?? effect.npc_rank.rank;
    return { line: `${josa(playerCalls(state, content, id), "은/는")} 이제 ${label}다.` };
  }
  if ("set_commander" in effect) {
    if (effect.set_commander.who === "reset") {
      if (!state.commanderOverride) return {};
      store.append({ type: "commander_changed", characterId: null });
      const back = commanderOf(store.getState(), content);
      return { line: back ? `상관이 다시 ${playerCalls(state, content, back)}(이)다.` : "" };
    }
    const id = whoOf(ctx, effect.set_commander.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || id === playerId || id === commanderOf(state, content)) return {};
    store.append({ type: "commander_changed", characterId: id });
    return { line: `이제 주인공의 상관은 ${playerCalls(state, content, id)}다. 임무와 회의는 이 사람에게서 받는다.` };
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
  if ("standing" in effect) {
    const note = changeStanding(ctx, playerId, effect.standing, reason);
    return note ? { line: note } : {};
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
  if ("capture_player" in effect) {
    const by = factionRef(state, effect.capture_player.by);
    const line = by ? capturePlayer(ctx, by, effect.capture_player.zone, reason) : null;
    return line ? { line } : {};
  }
  if ("release_player" in effect) {
    const me = state.characters[playerId]!;
    if (!me.captive) return {};
    const line = releasePlayer(ctx, effect.release_player.returned);
    const home = effect.release_player.home ? Object.values(content.locations).find((l) => l.owner === me.factionId && l.kind === "base")?.id : undefined;
    if (home && home !== store.getState().playerZone) store.append({ type: "zone_moved", from: store.getState().playerZone, to: home });
    return { line: `${line ?? "풀려났다."}${home ? ` ${content.locations[home]?.name ?? home}(으)로 돌아왔다.` : ""}` };
  }
  if ("deposit_weapons" in effect) {
    const zone = state.playerZone;
    const me = state.characters[playerId]!;
    if (!zone) return {};
    const items = Object.fromEntries(Object.entries(me.inventory).filter(([id, n]) => n > 0 && content.items[id]?.kind === "weapon"));
    if (Object.keys(items).length === 0) return {};
    store.append({ type: "items_deposited", zone, items });
    const names = Object.entries(items).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ");
    return { line: `무기를 맡겼다 (${names}). ${content.locations[zone]?.name ?? zone}을(를) 떠날 때 돌려받는다.` };
  }
  if ("cultivate" in effect) {
    const me = state.characters[playerId]!;
    const zone =
      effect.cultivate.where === "base" ? Object.values(content.locations).find((l) => l.owner === me.factionId && l.kind === "base")?.id : state.playerZone;
    if (!zone || !me.factionId || state.zones[zone]?.owner !== me.factionId) return {};
    store.append({ type: "zone_boosted", zone, resource: effect.cultivate.resource, delta: effect.cultivate.delta });
    return { line: `${content.locations[zone]?.name ?? zone}에서 나는 것이 늘 것이다 (빼앗기면 사라진다).` };
  }
  if ("train" in effect) {
    const me = state.characters[playerId]!;
    const { skill } = effect.train;
    const move = content.scenario.moves.find((m) => m.id === skill);
    if (!move) return {};
    const now = me.skills[skill] ?? move.default;
    const max = Math.min(effect.train.max, content.scenario.ranges.skill.max);
    if (now >= max) return {};
    store.append({ type: "skill_trained", characterId: playerId, skill, to: now + 1 });
    return { line: `배웠다: ${move.label} ${now >= 0 ? "+" : ""}${now} → +${now + 1}.` };
  }
  if ("delay" in effect) {
    store.append({ type: "time_advanced", activity: "wait", from: state.time, to: state.time + effect.delay });
    return { line: `시간이 더 걸렸다 (${Math.round(effect.delay / 60)}시간쯤).` };
  }
  if ("lose_item" in effect) {
    const { item } = effect.lose_item;
    const have = state.characters[playerId]!.inventory[item] ?? 0;
    const quantity = Math.min(have, effect.lose_item.quantity);
    if (quantity <= 0) return {};
    store.append({ type: "item_consumed", holder: playerId, itemId: item, quantity });
    return { line: `${josa(`${content.items[item]?.name ?? item} ×${quantity}`, "을/를")} 잃었다.` };
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
    const id = factionRef(state, effect.faction_morale.faction);
    if (!state.factions[id]) return {};
    store.append({ type: "faction_morale_changed", factionId: id, delta: effect.faction_morale.delta });
    return {};
  }
  if ("faction_relation" in effect) {
    const own = state.characters[playerId]!.factionId;
    const id = (x: string) => factionRef(state, x);
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
    if (effect.body.chance < 1 && ctx.rng() >= effect.body.chance) return {}; // 이번엔 아무 일도 없었다 (아무도 모른다)
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
    const id = factionRef(state, effect.faction_resource.faction);
    if (!state.factions[id]) return {};
    store.append({ type: "faction_resource_changed", factionId: id, resource, delta });
    return {}; // 창고 사정은 배급과 소문으로만 드러난다
  }
  if ("send_to" in effect) {
    const to = effect.send_to;
    if (!content.locations[to] || state.playerZone === to) return {};
    store.append({ type: "zone_moved", from: state.playerZone, to });
    return { line: `${content.locations[to]!.name}(으)로 옮겨졌다. 함께 있던 인물은 따라오지 않는다.` };
  }
  if ("reveal_tie" in effect) {
    const a = whoOf(ctx, effect.reveal_tie.who, cast);
    const b = whoOf(ctx, effect.reveal_tie.other, cast);
    const tie = a && b ? tiesOf(state, content, a).find((t) => t.other === b) : undefined;
    if (!tie || tieKnown(state, tie)) return {};
    store.append({ type: "tie_revealed", key: tie.key });
    return { line: `알게 된 관계: ${playerCalls(state, content, a!)}은(는) ${playerCalls(state, content, b!)}의 ${TIE_LABELS[tie.kind]}다.` };
  }
  if ("faction_policy" in effect) {
    const { topic, option } = effect.faction_policy;
    const id = factionRef(state, effect.faction_policy.faction);
    const t = content.scenario.command?.policies.find((p) => p.id === topic);
    const o = t?.options.find((x) => x.id === option);
    if (!state.factions[id] || !t || !o) return {};
    store.append({ type: "faction_policy_set", factionId: id, topic, option });
    // 자기 무리의 방침만 안다
    return id === state.characters[playerId]!.factionId ? { line: `무리 방침이 바뀌었다: ${t.label} ${o.label}. ${o.summary}` } : {};
  }
  if ("join_faction" in effect) {
    const player = state.characters[playerId]!;
    const { faction, rank, title } = effect.join_faction;
    if (!content.factions[faction] || player.factionId === faction) return {};
    const from = player.factionId ? (content.roles[state.roleId]?.label ?? content.factions[player.factionId]?.name ?? "") : "무소속";
    // 붙잡은 무리에 들면 더는 포로가 아니다 (빼앗긴 것도 돌려받는다, 12-55)
    if (player.captive) releasePlayer(ctx, player.captive.by === faction);
    const role = joinRole(content, faction, rank, { age: player.age, title, occupation: player.occupation?.id ?? null });
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
  if ("companion_join" in effect) {
    const id = whoOf(ctx, effect.companion_join.who, cast);
    const c = id ? state.characters[id] : undefined;
    if (!id || !c || id === playerId || c.dead || c.away || c.captive || state.companions.includes(id)) return {};
    const template = c.extra?.template ? content.extras[c.extra.template] : undefined;
    const kind = effect.companion_join.kind ?? (template?.animal ? "animal" : "purpose");
    const u = effect.companion_join.until;
    const until =
      kind === "purpose"
        ? { ...(u?.flag ? { flag: u.flag } : {}), ...(u?.zone ? { zone: u.zone } : {}), ...(u?.hours || !(u?.flag || u?.zone) ? { at: state.time + (u?.hours ?? 48) * 60 } : {}) }
        : undefined;
    store.append({ type: "companion_joined", characterId: id, kind, ...(until ? { until } : {}) });
    const name = playerCalls(store.getState(), content, id);
    return { line: `${josa(name, "이/가")} 이제 함께 다닌다 (구역을 옮겨도 따라온다).`, display: { type: "presence", npcName: name, action: "enter" } };
  }
  if ("companion_part" in effect) {
    const id = whoOf(ctx, effect.companion_part.who, cast);
    if (!id || !state.companions.includes(id)) return {};
    if (!state.bonds?.[id]) {
      const t = state.characters[id]?.extra?.template;
      store.append({ type: "companion_bond_changed", characterId: id, kind: t && content.extras[t]?.animal ? "animal" : "kin" });
    }
    const name = playerCalls(state, content, id);
    if (!effect.companion_part.hours) {
      if (!state.playerZone) return {};
      store.append({ type: "companion_parted", characterId: id, zone: state.playerZone, until: null });
      return { line: `${josa(name, "은/는")} ${content.locations[state.playerZone]?.name ?? state.playerZone}에 남아 기다린다. 이 구역에 다시 오면 합류한다.` };
    }
    const until = state.time + effect.companion_part.hours * 60;
    store.append({ type: "companion_parted", characterId: id, zone: null, until });
    return { line: `${josa(name, "은/는")} 잠시 떨어져 간다. ${formatTime(until)}쯤 돌아온다.` };
  }
  if ("companion_leave" in effect) {
    const id = whoOf(ctx, effect.companion_leave.who, cast);
    if (!id || !state.companions.includes(id)) return {};
    store.append({ type: "companion_left", characterId: id });
    return { line: `${josa(playerCalls(state, content, id), "은/는")} 더는 함께 다니지 않는다.` };
  }
  if ("npc_body" in effect) {
    const { track, delta, chance } = effect.npc_body;
    const id = whoOf(ctx, effect.npc_body.who, cast);
    if (!id || id === playerId || track === content.scenario.harm_track) return {};
    if (chance < 1 && ctx.rng() >= chance) return {}; // 이번엔 아무 일도 없었다 (아무도 모른다)
    const change = changeCondition(ctx, id, track, delta, "이야기", reason);
    // 장면에 있는 사람의 보이는 변화만 GM에게 알린다 (숨은 단계는 아무도 모른다)
    return change?.line && store.getState().scene.present.includes(id) ? { line: change.line, display: change.display ?? undefined } : {};
  }
  if ("debt" in effect) {
    const id = factionRef(state, effect.debt.faction);
    if (!content.factions[id]) return {};
    const before = state.characters[playerId]!.debts[id] ?? 0;
    const delta = Math.max(-before, effect.debt.delta);
    if (delta === 0) return {};
    store.append({ type: "debt_changed", characterId: playerId, factionId: id, delta });
    const after = before + delta;
    const name = content.factions[id]!.name;
    return { line: delta > 0 ? `${name}에 빚을 졌다 (장부에 올랐다).` : after === 0 ? `${name}에 진 빚을 다 갚았다.` : `${name}에 진 빚을 조금 갚았다.` };
  }
  if ("npc_capture" in effect) {
    const id = whoOf(ctx, effect.npc_capture.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || npc.away || npc.captive || id === playerId) return {};
    const by = factionRef(state, effect.npc_capture.by);
    if (!content.factions[by]) return {};
    const zone = effect.npc_capture.zone ?? Object.values(content.locations).find((l) => l.owner === by && l.kind === "base")?.id;
    if (!zone) return {};
    store.append({ type: "npc_captured", npcId: id, by, zone });
    const name = playerCalls(state, content, id);
    return { line: `${josa(name, "은/는")} ${content.factions[by]!.name}에 붙잡혀 ${content.locations[zone]?.name ?? zone}에 갇혔다.`, display: { type: "presence", npcName: name, action: "leave" } };
  }
  if ("npc_release" in effect) {
    const id = whoOf(ctx, effect.npc_release.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc?.captive) return {};
    store.append({ type: "npc_released", npcId: id });
    const name = playerCalls(state, content, id);
    return { line: `${josa(name, "은/는")} 풀려나 ${content.factions[npc.factionId]?.name ?? "제 갈 길"} 쪽으로 돌아간다.`, display: { type: "presence", npcName: name, action: "leave" } };
  }
  if ("npc_depart" in effect) {
    const id = whoOf(ctx, effect.npc_depart.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || npc.away) return {};
    // own: 주인공의 무리로 데려온다 (무소속이면 아무 일도 없다)
    const to = effect.npc_depart.to_faction === "own" ? state.characters[playerId]!.factionId || null : (effect.npc_depart.to_faction ?? null);
    if (effect.npc_depart.to_faction === "own" && !to) return {};
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

/**
 * 길 위의 일 (12-53): 구역을 옮긴 뒤 길의 위험별 확률로 길 위의 이야기 하나를 연다 (이야기 사이 간격과 상관없다).
 * 진행 중인 이야기가 있으면 열지 않는다. 연 이야기의 시작 표시를 돌려준다
 */
export function runRoadEvent(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const travel = content.scenario.travel;
  const state = store.getState();
  if (!travel || !state.lastRoute || state.activeStorylet || state.battle) return [];
  const chance = travel.chance[Math.min(3, routeDanger(content, state))] ?? 0;
  if (rng() >= chance) return [];
  const storylet = pickStorylet(roadStorylets(state, content, travel.tag), rng);
  if (!storylet) return [];
  const displays = fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!);
  displays.push({ type: "storylet", event: "started", title: storylet.title, detail: setupText(store.getState(), content) });
  return displays;
}

/**
 * 효과의 무리 자리: own = 주인공의 무리, zone_owner = 지금 구역의 주인 (다투는 땅, 12-54), 그 밖은 세력 id.
 * 주인이 없으면 빈 문자열 (효과가 아무 일도 하지 않는다)
 */
function factionRef(state: GameState, x: string): string {
  if (x === "own") return state.characters[state.playerId]?.factionId ?? "";
  if (x === "zone_owner") return (state.playerZone && state.zones[state.playerZone]?.owner) || "";
  if (x === "captor") return state.characters[state.playerId]?.captive?.by ?? "";
  return x;
}
