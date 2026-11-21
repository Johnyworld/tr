import { blameSuspended } from "../rules/blame.ts";
import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { bleedFromHarm } from "./bleeding.ts";
import { equippedItem, wearItem } from "./gear.ts";
import { carriedCount, itemCarriers } from "../game/companions.ts";
import { isInfected } from "../game/kinds.ts";
import { activeMissionOf, atMissionPlace } from "../game/missions.ts";
import { springEnemyAmbush } from "./ambush.ts";
import { formSquad, refugeeToSquad } from "./promotion.ts";
import { soak } from "./climate.ts";
import { prepareDisaster } from "./disasters.ts";
import { nudgeAgenda } from "./agenda.ts";
import { recentlyDeadComrade } from "./legacy.ts";
import { setResolve, stepResolve } from "./resolve.ts";
import { capturePlayer, releasePlayer } from "./captivity.ts";
import { onSpotted, threatStaysOnMiss } from "../rules/consequence.ts";
import { rankName } from "../game/ranks.ts";
import { exposeToFatigue } from "./fatigue.ts";
import { barrierRise, baseInfestation, infestationOf } from "../game/infestation.ts";
import { exposeToCold } from "./climate.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";
import { TIE_LABELS, tieKnown, tiesOf } from "../game/ties.ts";
import { dayOf, formatTime } from "../rules/time.ts";
import { harmTrack, learnedSkill } from "../scenario/scenario.ts";
import { changeCondition, shakeNerves } from "./body.ts";
import { disposition, neighbors } from "../sim/war.ts";
import { createExtraCharacter } from "./extras.ts";
import { EXTRA_CAST_PREFIX, dedupeAlias, storyletAllowed, inCrisis } from "../story/storylets.ts";
import { joinRole } from "../game/customStart.ts";
import { z } from "zod";
import { knowsName, playerCalls, hasMet } from "../game/acquaintance.ts";
import { withCharm } from "./charm.ts";
import { enterScene } from "./extras.ts";
import { changeStanding, gainMeritXp } from "./growth.ts";
import type { Content, StoryletContent, StoryletEffect } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { roleOf, type GameState } from "../game/state.ts";
import { DEED_TAG_LABELS, RELATION_AXIS_LABELS } from "../game/reputation.ts";
import { CHECK_OUTCOME_LABELS, type CheckOutcome } from "../rules/check.ts";
import { moveLabel } from "../scenario/scenario.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import { WAR_INTEL_TOPIC } from "./warTools.ts";
import {
  choiceAvailable,
  eligibleStorylets,
  fillStorylet,
  MISSION_PLACE_STORY_BOOST,
  pickCast,
  pickStorylet,
  roadStorylets,
  routeDanger,
  storyletVars,
  storyletWindow,
} from "../story/storylets.ts";
import { josa, sentence, type JosaPair } from "../text.ts";
import { recordDeed } from "./reputationTools.ts";
import { leveragesOn } from "./leverage.ts";
import { commanderOf } from "../game/missions.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, DEATH_GUIDE } from "./toolkit.ts";

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
  if (s) displays.push({ type: "storylet", event: "expired", title: storyTitle(store.getState(), content, s), detail: reason });
  return displays;
}

/** 기한 전에 시작한 행동(이야기 선택지의 판정)이 기한을 넘겨 끝나도 이만큼은 이야기를 붙잡아 둔다 (B6, 플레이 테스트 9) */
const EXPIRE_GRACE_MINUTES = 120;

export function runStorylets(ctx: ToolContext, options: { urgentOnly?: boolean; actionStartedAt?: number } = {}): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const displays: ToolDisplayEvent[] = [];
  let state = store.getState();
  const active = state.activeStorylet;
  const heldByAction = !!active && options.actionStartedAt !== undefined && options.actionStartedAt < active.expiresAt && state.time < active.expiresAt + EXPIRE_GRACE_MINUTES;
  if (active && state.time >= active.expiresAt && !heldByAction) {
    displays.push(...endActiveStorylet(ctx, "지나갔다"));
    state = store.getState();
  }
  const player = state.characters[state.playerId];
  const window = storyletWindow(state, content, state.time);
  if (!player || player.dead || window === "closed") return displays;
  // 고정 이야기(한 번뿐인 것)가 열릴 수 있으면 먼저 연다. 반복되는 템플릿에 밀려 묻히지 않게
  const eligible = eligibleStorylets(state, content).filter((s) => storyletAllowed(state, content, s, window, state.time, options));
  const fixed = eligible.filter((s) => !s.repeatable);
  // 임무 자리에 있으면 그 자리에 묶인 이야기를 더 자주 (G4)
  const mission = activeMissionOf(state.missions, state.playerId);
  const atPlace = !!mission && !!state.playerZone && atMissionPlace(mission, state.playerZone, state.zones, state.factions);
  const boost = (s: StoryletContent) => (atPlace && s.when.zones?.includes(state.playerZone!) ? MISSION_PLACE_STORY_BOOST : 1);
  const storylet = pickStorylet(fixed.length ? fixed : eligible, rng, boost);
  if (!storylet) return displays;
  displays.push(...fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!));
  displays.push({ type: "storylet", event: "started", title: storyTitle(store.getState(), content, storylet), detail: setupText(store.getState(), content) });
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
  // 이야기가 말하는 몸 상태를 진짜로 (플레이 테스트 12: "다리가 깔렸다", "굶었다"인데 상태는 멀쩡했다). 이미 더 나쁘면 그대로
  for (const [key, id] of Object.entries(cast)) {
    for (const [track, level] of Object.entries(storylet.cast[key]?.starts ?? {})) {
      const levels = content.scenario.condition_tracks.find((t) => t.id === track)?.levels ?? [];
      const now = store.getState().characters[id];
      const want = levels.findIndex((l) => l.id === level);
      const have = Math.max(0, levels.findIndex((l) => l.id === now?.conditions[track]));
      if (now && !now.dead && want > have) changeCondition(ctx, id, track, want - have, "cheat", storyTitle(store.getState(), content, storylet));
    }
  }
  // 이름표로 기억해 둔다 (다음 이야기에서 recall로 다시 부른다)
  for (const [key, id] of Object.entries(cast)) {
    const keep = storylet.cast[key]?.keep;
    if (keep) store.append({ type: "extra_kept", key: keep, characterId: id });
  }
  // 적의 매복 (12-177): 열리면 주인공이 매복당한다 (곁의 개가 알아채면 아니다). 줄은 GM 상태의 전투 칸에 보인다
  if (storylet.ambush) springEnemyAmbush(ctx);
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
    if (heldOf(now.characters[id]) && heldOf(now.characters[id]!)!.zone !== now.playerZone) continue;
    enterScene(ctx, id);
    displays.push({ type: "presence", npcName: playerCalls(store.getState(), content, id), action: "enter" });
  }
  return displays;
}

/** 빨리감기 중 스토리렛이 열릴 수 있게 되면 멈춘다 */
export function createStoryletCheck(content: Content, options: { asleep?: boolean; activity?: string } = {}): InterruptCheck {
  return ({ state: before, to }) => {
    if (Object.keys(content.storylets).length === 0) return null;
    // 지금 하는 일로 조건을 본다 (when.activities): 활동의 시간은 아직 기록되기 전이다
    const state = options.activity ? { ...before, lastActivity: options.activity } : before;
    const window = storyletWindow(state, content, to);
    if (window === "closed") return null;
    // 자는 동안·이야기 사이 간격 안에는 급한 일만 (나머지는 그 뒤에 열린다)
    const eligible = eligibleStorylets(state, content, to).filter((s) => storyletAllowed(state, content, s, window, to, { urgentOnly: options.asleep }));
    return eligible.length > 0 ? { kind: "storylet", detail: "일이 생겼다", at: to } : null;
  };
}

function activeOf(state: GameState, content: Content): { storylet: StoryletContent; cast: Record<string, string> } | null {
  const active = state.activeStorylet;
  const storylet = active ? content.storylets[active.id] : undefined;
  return active && storylet ? { storylet, cast: active.cast } : null;
}

/** 이번에 쓸 상황 문장 (12-139): 몇 번째로 열렸는지에 따라 setup과 variants를 돌아가며 */
export function storySetup(state: GameState, storylet: StoryletContent): string {
  const all = [storylet.setup, ...(storylet.variants ?? [])];
  const n = Math.max(1, state.storyletLog[storylet.id]?.fired ?? 1);
  return all[(n - 1) % all.length]!;
}

function setupText(state: GameState, content: Content): string {
  const a = activeOf(state, content);
  if (!a) return "";
  return maskUnknownNames(state, content, fillStorylet(storySetup(state, a.storylet), storyletVars(state, content, a.cast)));
}

/** GM 컨텍스트: 진행 중인 이야기. 조건(클락 등)은 넣지 않는다 */
export function describeStoryletForGm(state: GameState, content: Content): string {
  const a = activeOf(state, content);
  if (!a) return "";
  const vars = storyletVars(state, content, a.cast);
  const lines = [
    `진행 중인 이야기: ${storyTitle(state, content, a.storylet)}`,
    // 배역이 아닌 인물의 이름도 주인공이 모르면 호칭으로 (12-192)
    `  상황: ${maskUnknownNames(state, content, fillStorylet(storySetup(state, a.storylet), vars), { story: true })}`,
    ...(a.storylet.ai_direction ? [`  [GM 전용] 연출: ${maskUnknownNames(state, content, fillStorylet(a.storylet.ai_direction, vars), { story: true })}`] : []),
    `  등장: ${Object.entries(a.cast).map(([k, id]) => `${k}=${vars[k]}(${id})`).join(", ") || "없음"}`,
    `  선택지 (resolve_storylet): ${a.storylet.choices
      .filter((c) => choiceAvailable(state, c, a.cast))
      // 배우지 않은 전문 기술의 선택지는 미리 "못 함"으로 (플레이 테스트 12: 고르면 거절돼 남는 길이 하나뿐인 줄 몰랐다)
      .map((c) => {
        const unable = !!c.check && learnedSkill(content.scenario, state.characters[state.playerId]?.skills ?? {}, c.check) === null;
        const tag = !c.check ? "" : unable ? ` [못 함: ${josa(moveLabel(content.scenario, c.check), "을/를")} 배우지 않았다]` : ` [먼저 take_action에서 ${moveLabel(content.scenario, c.check)}(${c.check}) 판정]`;
        return `${c.id} ${maskUnknownNames(state, content, fillStorylet(c.label, vars), { story: true })}${tag}`;
      })
      .join(" / ")}`,
    "  이 상황을 장면으로 연출하고, 플레이어가 어느 쪽을 택했는지 분명해지면 resolve_storylet을 호출한다. 결과(효과)를 미리 말하거나 지어내지 않는다. 플레이어가 모른 척하기로 하면 다음 take_action에 ignore_story: true (효과 없이 지나간다). 이야기를 둔 채 같은 자리에서 오래 걸리는 일(잠·기다림·보초·수색·일)은 거절된다. 자리를 옮기면 외면하는 선택지로 풀린다.",
  ];
  return lines.join("\n");
}

export const resolveStorylet = defineTool({
  name: "resolve_storylet",
  description:
    "진행 중인 이야기(상태의 '진행 중인 이야기')에서 플레이어가 고른 선택지를 알린다. 효과는 시스템이 적용한다. " +
    "판정이 붙은 선택지는 같은 턴에 take_action으로 그 판정을 먼저 한 뒤 호출한다. " +
    "플레이어가 선택지에 없는 방법을 썼어도 결과의 성격(맞서기·속이기·달아나기 등)이 어느 선택지와 같으면 그 선택지로 즉흥으로 푼다: 그 방법에 맞는 스킬로 판정하고 improvised_move에 적는다 (효과는 그 선택지의 것). " +
    "결과의 성격이 어느 선택지와도 다르면 호출하지 않고 평소처럼 진행한다.",
  schema: z.strictObject({
    choice_id: z.string().describe("선택지 id (플레이어의 행동과 결과의 성격이 같은 것)"),
    improvised_move: z
      .string()
      .nullable()
      .default(null)
      .describe("즉흥으로 풀 때: 이번 턴 take_action에서 실제로 판정한 스킬 (선택지의 스킬과 다를 때만). 아니면 null"),
  }),
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
      // 이번 턴 그 행동의 판정 결과로 갈린다. 즉흥으로 풀면 플레이어의 방법에 맞는 스킬의 판정으로 (12-145)
      const move = input.improvised_move ?? choice.check;
      if (!ctx.content.scenario.moves.some((m) => m.id === move)) return { ok: false, error: `알 수 없는 스킬: ${move}` };
      const check = Object.values(state.checks)
        .filter((c) => c.turn === state.turn && c.actorId === state.playerId && c.move === move)
        .at(-1);
      if (!check) {
        return { ok: false, error: `이 선택지는 이번 턴 take_action에서 ${moveLabel(ctx.content.scenario, move)}(${move}) 판정을 먼저 해야 한다.` };
      }
      outcome = check.outcome;
      effects = choice.outcomes![check.outcome];
      // 그 판정에서 이미 다쳤으면 이야기의 "다친다"는 겹쳐 붙이지 않는다 (플레이 테스트 8: 판정 한 번 실패로 두 단계, 의식불명 → 죽음)
      if (check.harmApplied) effects = effects.filter((e) => !("wound" in e));
    }
    // 내놓을 물건이 없으면 고를 수 없다 (거래 선택지)
    const player = state.characters[state.playerId]!;
    // 값으로 내놓는 물건(판정 없는 선택지)만 막는다. 판정 결과로 빼앗기는 것은 가진 만큼만 (B7)
    for (const e of choice.outcomes && outcome !== "success" ? [] : effects) {
      if ("take_item" in e && carriedCount(state, e.take_item.item) < e.take_item.quantity) {
        const name = ctx.content.items[e.take_item.item]?.name ?? e.take_item.item;
        return { ok: false, error: `${josa(`${name} ×${e.take_item.quantity}`, "이/가")} 없어 이 선택지를 고를 수 없다. 다른 선택지를 고르거나 그대로 둔다.` };
      }
    }
    const vars = storyletVars(state, ctx.content, a.cast);
    ctx.store.append({ type: "storylet_resolved", storyletId: a.storylet.id, choiceId: choice.id, outcome });
    const improvised = !!input.improvised_move && input.improvised_move !== choice.check;
    const lines: string[] = [
      `이야기 "${storyTitle(state, ctx.content, a.storylet)}": ${improvised ? `플레이어의 방법으로 즉흥으로 풀었다 (${moveLabel(ctx.content.scenario, input.improvised_move!)} 판정, "${maskUnknownNames(state, ctx.content, fillStorylet(choice.label, vars))}"의 결과를 따른다)` : maskUnknownNames(state, ctx.content, fillStorylet(choice.label, vars))}${outcome ? ` (${CHECK_OUTCOME_LABELS[outcome]})` : ""}.`,
    ];
    const extra: ToolDisplayEvent[] = [];
    for (const effect of effects) {
      const r = applyEffect(ctx, effect, a.cast, vars, a.storylet.title);
      if (r.line) lines.push(r.line);
      if (r.display) extra.push(r.display);
      if (r.displays) extra.push(...r.displays);
    }
    // 시간이 더 걸렸으면 그동안의 세계를 돌린다 (배급, 소문, 전쟁, 몸). 그사이 몸에 생긴 일도 GM에게 문장으로 (플레이 테스트 8)
    if (effects.some((e) => "delay" in e)) {
      const after = runAfterTimeAdvance(ctx);
      extra.push(...after);
      for (const d of after) {
        if (d.type === "harm" && d.trackLabel) lines.push(`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.cause}).`);
        else if (d.type === "heal") lines.push(`${d.targetName}의 ${d.trackLabel}: ${d.fromLabel} → ${d.toLabel} (${d.byLabel}).`);
        else if ((d.type === "belief" || d.type === "harm") && d.note) lines.push(d.note);
      }
    }
    // 이야기로 들어온 배역은 이야기가 끝나면 장면을 떠난다 (B13, 플레이 테스트 9: 배역이 장면에 쌓였다). 함께 다니게 된 사람은 남는다
    // 무리에 든 선택지면 그 사람들이 곁에 남는다 (새 상관과 다음 장면이 이어진다)
    if (!effects.some((e) => "join_faction" in e)) {
      const now = ctx.store.getState();
      const left: string[] = [];
      // 위협 이야기(겁을 주는 이야기·매복)를 실패하면 위협은 장면에 남는다: 이어서 맞서거나 달아난다 (플레이 테스트 13: 들켰는데 배역이 빠지고 아무 일도 없었다)
      const threatStays = threatStaysOnMiss(ctx.content, a.storylet.id, outcome);
      const stayed: string[] = [];
      for (const [key, id] of Object.entries(a.cast)) {
        if (threatStays && now.scene.present.includes(id) && !now.companions.includes(id) && !now.characters[id]?.dead) {
          stayed.push(playerCalls(now, ctx.content, id));
          continue;
        }
        // 치료사는 곁에 남는다: 이야기가 끝난 뒤 치료를 받을 수 있게 (플레이 테스트 13: 침상 곁의 의사가 빠져 치료가 거절됐다)
        if (!a.storylet.cast[key]?.enter || !now.scene.present.includes(id) || now.companions.includes(id) || id === commanderOf(now, ctx.content) || id === roleOf(ctx.content, now)?.commander || !!ctx.content.npcs[id]?.healer) continue;
        ctx.store.append({ type: "npc_left", npcId: id });
        left.push(playerCalls(now, ctx.content, id));
      }
      if (left.length) lines.push(`이야기 배역(${left.join(", ")})은 장면에서 빠졌다. 장면이 이어져 더 마주하면 npc_presence enter.`);
      if (stayed.length) lines.push(`위협은 그대로 장면에 남았다: ${stayed.join(", ")}. 다음 행동에서 맞서거나(target) 달아나는(move_to + 판정) 장면으로 잇는다.`);
    }
    // 이야기 해결 중에 죽었으면 (쓰러진 사이 붙잡히거나 죽임 등) 다음 행동에서야 알게 하지 않는다
    if (ctx.store.getState().characters[ctx.store.getState().playerId]?.dead) lines.push(`${DEATH_GUIDE} 장면을 끝내고 더 이상 행동을 제시하지 마라.`);
    else lines.push("이 결과에 맞게 이야기를 마무리하는 장면을 서술하라.");
    return {
      ok: true,
      resultText: lines.join("\n"),
      display: { type: "storylet", event: "resolved", title: storyTitle(state, ctx.content, a.storylet), detail: maskUnknownNames(state, ctx.content, fillStorylet(choice.label, vars)) },
      extra,
    };
  },
});

/**
 * 콘텐츠 문장에 적힌 이름 중 주인공이 아직 모르는 것은 호칭으로 바꾼다 (원칙 4, 플레이 테스트 8: "주옥희는…", "피정호 신부는…").
 * 배역은 {자리}로 쓰면 저절로 호칭이 되지만, 배역이 아닌 인물을 이름으로 적은 문장이 많다
 */
/** 이야기 제목도 이름을 흘리지 않는다 (플레이 테스트 11: 이름 모르는 사람의 "최선희의 공책") */
export function storyTitle(state: GameState, content: Content, storylet: { title: string }): string {
  return maskUnknownNames(state, content, storylet.title);
}

/** story: 이야기 글이면 만난 적도 장면에도 없는 사람은 "누군가"로 (겉모습·직업의 호칭이 정체를 알려 준다, 플레이 테스트 13) */
export function maskUnknownNames(state: GameState, content: Content, text: string, options: { story?: boolean } = {}): string {
  let out = text;
  for (const npc of Object.values(content.npcs)) {
    if (!npc.name || !out.includes(npc.name) || knowsName(state, state.playerId, npc.id)) continue;
    const stranger = !!options.story && !hasMet(state, state.playerId, npc.id) && !state.scene.present.includes(npc.id);
    const alias = stranger ? "누군가" : playerCalls(state, content, npc.id);
    // 이름 뒤에 붙었던 조사는 호칭에 맞춰 다시 붙인다 (B9, 플레이 테스트 9: "경비병가", "탄약 장수은")
    const escaped = npc.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 앞말과 겹치는 호칭은 접는다 (C4, "규율반원 석중기에게" → "규율반원에게")
    let next = "";
    let last = 0;
    for (const m of out.matchAll(new RegExp(`${escaped}(이었다|였다|이라는|라는|으로|로|이|가|은|는|을|를|과|와)?`, "g"))) {
      next += out.slice(last, m.index);
      last = m.index! + m[0].length;
      const particle = m[1];
      // 이름 자체가 내용이면 호칭으로 바꾸지 않고 가린다 (플레이 테스트 12: "윤채원이라는 이름" → "의무실 여자라는 이름")
      if ((particle === "이라는" || particle === "라는") && out.slice(last).startsWith(" 이름")) {
        next += "어떤 사람의";
        continue;
      }
      // 앞말이 직함(조사 없이 끝나는 낱말, "하얀매 대표 ○○")이면 호칭을 빼고 직함에 조사를 붙인다 (플레이 테스트 12: "하얀매 대표 흰 가운의 안경 쓴 여자가")
      // 직함: 그 사람의 계급 이름이나 직분 이름일 때만
      const title = next.endsWith(" ") ? (next.slice(0, -1).split(/\s/).at(-1) ?? "") : "";
      const titles = [rankName(content, npc.faction ?? null, npc.rank), ...(npc.occupation ? [content.scenario.occupations.find((o) => o.id === npc.occupation)?.label ?? ""] : [])].filter(Boolean);
      if (title.length >= 2 && titles.includes(title)) {
        next = next.slice(0, -1);
        next += particle ? josa(title, PARTICLE_PAIRS[particle]!).slice(title.length) : "";
        continue;
      }
      // 이름 뒤의 직함이 호칭의 끝 낱말과 같으면 직함을 뺀다 (플레이 테스트 12: "류경환 교수와는" → "교수 교수와는")
      const head = alias.split(" ").at(-1) ?? "";
      if (!particle && head && out.slice(last).startsWith(` ${head}`)) last += head.length + 1;
      const placed = dedupeAlias(next, alias, out.slice(last));
      next = placed.before;
      next += placed.value ? (particle ? josa(placed.value, PARTICLE_PAIRS[particle]!) : placed.value) : particle ? josa(alias, PARTICLE_PAIRS[particle]!).slice(alias.length) : "";
    }
    out = next + out.slice(last);
  }
  return out;
}

const PARTICLE_PAIRS: Record<string, JosaPair> = {
  이: "이/가", 가: "이/가", 은: "은/는", 는: "은/는", 을: "을/를", 를: "을/를", 과: "과/와", 와: "과/와",
  으로: "으로/로", 로: "으로/로", 이라는: "이라는/라는", 라는: "이라는/라는", 이었다: "이었다/였다", 였다: "이었다/였다",
};

function whoOf(ctx: ToolContext, who: string, cast: Record<string, string>): string | null {
  if (cast[who]) return cast[who]!;
  if (who === "commander") return commanderOf(ctx.store.getState(), ctx.content);
  return null;
}

/** 효과 하나를 적용한다. GM에게 돌려줄 한 줄 (잠입의 목표처럼 이야기 밖에서도 쓴다, 12-154) */
export function applyEffect(
  ctx: ToolContext,
  effect: StoryletEffect,
  cast: Record<string, string>,
  vars: Record<string, string>,
  reason: string,
): { line?: string; display?: ToolDisplayEvent; displays?: ToolDisplayEvent[] } {
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
    const want = ["captor", "zone_owner"].includes(effect.overhear.faction) ? factionRef(state, effect.overhear.faction) : effect.overhear.faction;
    if (!want) return {};
    const progress = (f: string) => Math.max(0, ...Object.values(state.clocks).filter((c) => c.factionId === f).map((c) => c.filled / c.max));
    const pool = Object.keys(state.factions)
      .filter((f) => f !== me.factionId && content.factions[f]?.startable !== false)
      .filter((f) => want === "other" || (want === "enemy" ? !me.factionId || disposition(content, me.factionId, f, state) < 0 : f === want));
    const target = pool.sort((a, b) => progress(b) - progress(a) || a.localeCompare(b))[0];
    const clock = target ? Object.values(state.clocks).filter((c) => c.factionId === target).sort((a, b) => b.filled / b.max - a.filled / a.max)[0] : undefined;
    if (!target || !clock) return {};
    const ratio = clock.filled / clock.max;
    const stage = ratio >= 0.75 ? "거의 다 됐다" : ratio >= 0.4 ? "절반쯤 와 있다" : ratio > 0 ? "막 시작됐다" : "아직 말뿐이다";
    const fact = sentence(`${josa(content.factions[target]?.name ?? target, "이/가")} 준비하는 일: ${clock.label}. ${stage}`);
    store.append({
      type: "belief_added",
      characterId: playerId,
      belief: { id: `b_${state.nextBeliefNo}`, fact, source: effect.overhear.source, accuracy: "approximate", learnedAt: state.time, topic: WAR_INTEL_TOPIC },
    });
    return { line: `들은 소식: ${fact}`, display: { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[effect.overhear.source] } };
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
  if ("infested" in effect) {
    const zone = state.playerZone;
    if (!zone || !content.scenario.infestation) return {};
    const before = infestationOf(content, state, zone);
    const level = Math.max(0, Math.min(3, before + effect.infested));
    if (level === before) return {};
    store.append({ type: "infestation_changed", zone, level, cause: effect.infested < 0 ? "소탕" : "불러 모음" });
    return { line: effect.infested < 0 ? "이 구역의 감염체가 줄었다. 한동안 조용할 것이다." : "이 구역에 감염체가 더 몰려든다." };
  }
  if ("soak" in effect) {
    const shown = soak(ctx, playerId, "온몸이 젖었다");
    const d = shown[0];
    return d?.type === "harm" ? { line: `옷이 흠뻑 젖었다. ${d.cause.replace(/^온몸이 젖었다\. /, "")}.`, display: d } : {};
  }
  if ("zone_noise" in effect) {
    if (!state.playerZone) return {};
    store.append({ type: "noise_made", zone: state.playerZone, level: effect.zone_noise, day: dayOf(state.time) });
    return { line: "소리가 났다. 몇 시간 안에 이 구역에 무언가 몰려들 수 있다." };
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
  if ("put_down" in effect) {
    // 감염체만 이야기로 쓰러뜨린다. 사람은 원칙 3대로 죽지 않는다 (플레이 테스트 11: "소리 없이 처리한다"가 성공했는데 감염체가 경상으로 남았다)
    const id = whoOf(ctx, effect.put_down.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || id === playerId || !isInfected(content, npc)) return {};
    const track = harmTrack(content.scenario);
    const index = Math.max(0, track.levels.findIndex((l) => l.id === npc.conditions[track.id]));
    const fatal = track.levels.findIndex((l) => l.fatal);
    if (fatal <= index) return {};
    const change = changeCondition(ctx, id, track.id, fatal - index, "put_down", reason);
    return change?.line ? { line: change.line, display: change.display ?? undefined } : {};
  }
  if ("npc_rank" in effect) {
    const id = whoOf(ctx, effect.npc_rank.who, cast);
    const npc = id ? state.characters[id] : undefined;
    if (!id || !npc || npc.dead || id === playerId || npc.rank === effect.npc_rank.rank) return {};
    store.append({ type: "npc_rank_changed", npcId: id, rank: effect.npc_rank.rank });
    const label = content.scenario.rank_ladder.find((r) => r.id === effect.npc_rank.rank)?.label ?? effect.npc_rank.rank;
    return { line: `${josa(playerCalls(state, content, id), "은/는")} 이제 ${label}다.` };
  }
  if ("belief" in effect) {
    const fact = maskUnknownNames(state, content, sentence(fillStorylet(effect.belief.fact, vars)));
    // 되풀이되는 이야기가 같은 문장을 또 남기면 쌓지 않는다 (알게 된 것으로는 알린다)
    if (!(state.beliefs[playerId] ?? []).some((b) => b.fact === fact)) store.append({
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
  // 무리 안의 정치 (12-152): 주인공의 강등·추대, 쫓겨남
  if ("player_rank" in effect) {
    const player = state.characters[playerId]!;
    const to = effect.player_rank.rank;
    if (!player.factionId || player.rank === to) return {};
    store.append({ type: "promoted", characterId: playerId, from: player.rank, to });
    const fromLabel = rankName(content, player.factionId, player.rank);
    const toLabel = rankName(content, player.factionId, to);
    // 분대를 맡는 계급이 됐으면 분대를 꾸린다 (12-190)
    const squad = formSquad(ctx);
    return { line: [`${josa(player.name, "은/는")} 이제 ${toLabel}다 (전에는 ${fromLabel}).`, ...squad].join(" "), display: { type: "promotion", name: player.name, fromLabel, toLabel } };
  }
  if ("expel" in effect) {
    const player = state.characters[playerId]!;
    if (!player.factionId) return {};
    const from = content.factions[player.factionId]?.name ?? player.factionId;
    const fromLabel = rankName(content, player.factionId, player.rank);
    const rank = content.scenario.custom_start?.free_rank ?? content.scenario.rank_ladder[0]!.id;
    const role = joinRole(content, "", rank, { age: player.age, title: "떠돌이", occupation: player.occupation?.id ?? null });
    store.append({ type: "player_joined_faction", factionId: "", rank: role.rank, role, beliefs: [] });
    return {
      line: `${from}에서 쫓겨났다. 이제 무소속이다: 배급·임무·분대·회의가 끊겼고, 거점의 사물함은 쓸 수 없다 (맡긴 물건은 거기 남아 있다). 그 무리 사람들이 당신을 어떻게 볼지는 저마다 다르다.`,
      display: { type: "promotion", name: player.name, fromLabel: `${from} ${fromLabel}`, toLabel: "무소속" },
    };
  }
  if ("merit" in effect) {
    store.append({ type: "merit_awarded", characterId: playerId, delta: effect.merit, reason });
    const growthNote = gainMeritXp(ctx, playerId, effect.merit);
    return { line: `공적 ${effect.merit > 0 ? "+" : ""}${effect.merit}.` + (growthNote ? ` ${growthNote}` : "") };
  }
  if ("reveal_name" in effect) {
    const id = whoOf(ctx, effect.reveal_name.who, cast);
    const c = id ? state.characters[id] : undefined;
    if (!id || !c || (state.known[playerId] ?? []).includes(id)) return {};
    const alias = playerCalls(state, content, id);
    store.append({ type: "name_learned", characterId: playerId, targetId: id });
    const fact = `${alias}의 이름은 ${c.name}`;
    const now = store.getState();
    store.append({ type: "belief_added", characterId: playerId, belief: { id: `b_${now.nextBeliefNo}`, fact: sentence(fact), source: "report", accuracy: "exact", learnedAt: now.time } });
    return { line: `(이름을 알게 됐다: ${fact}. 이제 이 이름으로 부른다)`, display: { type: "belief", fact, sourceLabel: "이름" } };
  }
  if ("disaster_prepare" in effect) {
    const line = prepareDisaster(ctx);
    return line ? { line: `(${line})` } : {};
  }
  if ("agenda" in effect) {
    const id = whoOf(ctx, effect.agenda.who, cast);
    if (!id || id === playerId) return {};
    const out = nudgeAgenda(ctx, id, effect.agenda.delta, effect.agenda.stop);
    return out[0] ? { line: out[0].type === "belief" ? out[0].fact : undefined, display: out[0] } : {};
  }
  if ("resolve_step" in effect) {
    const line = stepResolve(ctx, fillStorylet(effect.resolve_step.text, vars));
    return line ? { line: `(${line})`, display: { type: "belief", fact: line, sourceLabel: "다짐" } } : {};
  }
  if ("resolve" in effect) {
    const e = effect.resolve;
    const pick = (x: string | null) =>
      x === null ? null : x === "zone" ? state.playerZone : x === "own" ? (state.characters[playerId]?.factionId ?? null) : x === "deceased" ? recentlyDeadComrade(state, content) : (whoOf(ctx, x, cast) ?? x);
    const line = setResolve(ctx, { kind: e.kind, target: pick(e.target), target2: pick(e.target2), n: e.n, text: fillStorylet(e.text, vars) }, "story");
    return line ? { line: `(${line}. 이것이 이제 주인공의 큰 줄기다)`, display: { type: "belief", fact: line, sourceLabel: "다짐" } } : {};
  }
  if ("give_item" in effect) {
    const { item, quantity } = effect.give_item;
    const name = content.items[item]?.name ?? item;
    if (effect.give_item.from) {
      const holder = whoOf(ctx, effect.give_item.from, cast);
      const have = holder ? (state.characters[holder]?.inventory[item] ?? 0) : 0;
      if (!holder || have < quantity) return { line: `${josa(name, "은/는")} 건네받을 수 없었다 (가진 것이 없다).` };
      store.append({ type: "item_transferred", from: holder, to: playerId, itemId: item, quantity });
      const fromName = playerCalls(state, content, holder);
      return { line: `${josa(fromName, "이/가")} ${josa(`${name} ×${quantity}`, "을/를")} 건넸다.`, display: { type: "item", fromName, toName: state.characters[playerId]!.name, itemName: name, quantity } };
    }
    store.append({ type: "item_granted", to: playerId, itemId: item, quantity });
    return { line: `${josa(`${name} ×${quantity}`, "을/를")} 얻었다.`, display: { type: "item", fromName: "", toName: state.characters[playerId]!.name, itemName: name, quantity } };
  }
  if ("end_romance" in effect) {
    const id = whoOf(ctx, effect.end_romance.who, cast);
    const r = id ? state.romances?.[[playerId, id].sort().join("|")] : undefined;
    if (!id || r?.stage !== "lovers") return {};
    store.append({ type: "romance_changed", a: playerId, b: id, stage: "ended" });
    return { line: `${josa(playerCalls(state, content, id), "과/와")}의 사이가 끝났다.` };
  }
  if ("npc_heal" in effect) {
    const id = whoOf(ctx, effect.npc_heal.who, cast);
    if (!id || id === playerId || !state.characters[id] || state.characters[id]!.dead) return {};
    const c = changeCondition(ctx, id, harmTrack(content.scenario).id, -effect.npc_heal.steps, "healer", "돌봄");
    return c?.line && store.getState().scene.present.includes(id) ? { line: c.line, display: c.display ?? undefined } : {};
  }
  if ("end_blackmail" in effect) {
    const id = whoOf(ctx, effect.end_blackmail.who, cast);
    if (!id || !state.blackmails.some((b) => b.npcId === id && b.by === playerId)) return {};
    const keys = effect.end_blackmail.drop ? leveragesOn(state, content, id).map((l) => l.key) : [];
    store.append({ type: "blackmail_ended", npcId: id, by: playerId, keys });
    return keys.length ? { line: `${playerCalls(state, content, id)}의 약점을 내려놓았다 (다시 쓰지 않는다).` } : {};
  }
  if ("clear_bounty" in effect) {
    const f = state.bounties[0];
    if (!f) return {};
    store.append({ type: "bounty_cleared", factionId: f });
    return { line: `${content.factions[f]?.name ?? f}의 현상금이 거둬졌다.` };
  }
  if ("settle_vendetta" in effect) {
    const id = whoOf(ctx, effect.settle_vendetta.who, cast);
    if (!id || !state.vendettas.some((v) => v.avenger === id)) return {};
    store.append({ type: "vendetta_settled", avenger: id });
    return {};
  }
  if ("grudge" in effect) {
    const id = whoOf(ctx, effect.grudge.who, cast);
    if (!id || !state.characters[id] || id === playerId) return {};
    const part = { kind: "enemy" as const, target: id, why: effect.grudge.why, knows_you: true };
    // 이름 있는 인물이 아니면 (엑스트라) 원수 목록에는 남기되 배경 플래그로
    const entries = [...state.background, { part: part as never, ...(content.npcs[id] ? {} : { characterId: id }) }];
    store.append({ type: "background_set", entries });
    for (const flag of ["bg_enemy", "bg_enemy_person"]) store.append({ type: "flag_set", characterId: playerId, flag });
    return { line: `${josa(playerCalls(state, content, id), "을/를")} 잊지 않는다. 이제 원수다.` };
  }
  if ("wound" in effect) {
    const me = state.characters[playerId]!;
    const track = harmTrack(content.scenario);
    const index = Math.max(0, track.levels.findIndex((l) => l.id === me.conditions[track.id]));
    const fatal = track.levels.findIndex((l) => l.fatal);
    const steps = Math.min(effect.wound.steps, Math.max(0, (fatal >= 0 ? fatal : track.levels.length) - 1 - index));
    if (steps <= 0) return {};
    const c = changeCondition(ctx, playerId, track.id, steps, "story", effect.wound.cause);
    const bleed = c?.display && effect.wound.kind ? bleedFromHarm(ctx, playerId, effect.wound.kind, steps === 1) : null;
    const line = [c?.line, bleed?.line].filter(Boolean).join(" ");
    return line ? { line, display: c?.display ?? undefined } : {};
  }
  if ("locate" in effect) {
    const id = whoOf(ctx, effect.locate.who, cast);
    const c = id ? state.characters[id] : undefined;
    if (!id || !heldOf(c)) return {};
    const fact = sentence(`${josa(playerCalls(state, content, id), "은/는")} ${content.factions[heldOf(c)!.by]?.name ?? heldOf(c)!.by}의 ${content.locations[heldOf(c)!.zone]?.name ?? heldOf(c)!.zone}에 갇혀 있다고 한다`);
    store.append({ type: "belief_added", characterId: playerId, belief: { id: `b_${state.nextBeliefNo}`, fact, source: effect.locate.source, accuracy: "approximate", learnedAt: state.time } });
    return { line: `알게 된 것: ${fact}`, display: { type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[effect.locate.source] } };
  }
  if ("capture_player" in effect) {
    const by = factionRef(state, effect.capture_player.by);
    // 믿음에 이야기 제목을 붙이지 않는다 (플레이 테스트 13: "초소의 호루라기. 청솔형제단에 붙잡혀 …")
    const line = by ? capturePlayer(ctx, by, effect.capture_player.zone, "붙잡혔다") : null;
    return line ? { line } : {};
  }
  if ("release_player" in effect) {
    const me = state.characters[playerId]!;
    if (!heldOf(me)) return {};
    const captor = heldOf(me)!.by;
    const line = releasePlayer(ctx, effect.release_player.returned);
    const here = store.getState().playerZone;
    // 빠져나간다: 붙잡은 무리 땅이 아닌 맞닿은 구역 (우리 땅 먼저)
    const out = effect.release_player.out && here
      ? neighbors(content, here)
          .filter((z) => store.getState().zones[z]?.owner !== captor)
          .sort((a, b) => Number(store.getState().zones[b]?.owner === me.factionId) - Number(store.getState().zones[a]?.owner === me.factionId) || a.localeCompare(b))[0]
      : undefined;
    const home = effect.release_player.home ? Object.values(content.locations).find((l) => l.owner === me.factionId && l.kind === "base")?.id : out;
    if (home && home !== store.getState().playerZone) store.append({ type: "zone_moved", from: store.getState().playerZone, to: home });
    return { line: `${line ?? "풀려났다."}${home ? ` ${josa(content.locations[home]?.name ?? home, "으로/로")} 돌아왔다.` : ""}` };
  }
  if ("deposit_weapons" in effect) {
    const zone = state.playerZone;
    const me = state.characters[playerId]!;
    if (!zone) return {};
    const items = Object.fromEntries(Object.entries(me.inventory).filter(([id, n]) => n > 0 && content.items[id]?.kind === "weapon"));
    if (Object.keys(items).length === 0) return {};
    store.append({ type: "items_deposited", zone, items });
    const names = Object.entries(items).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ");
    return { line: `무기를 맡겼다 (${names}). ${josa(content.locations[zone]?.name ?? zone, "을/를")} 떠날 때 돌려받는다.` };
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
    // 못 하던 전문 기술은 배운 상태(최저값)가 된다 (4.2.1)
    const now = learnedSkill(content.scenario, me.skills, skill);
    const max = Math.min(effect.train.max, content.scenario.ranges.skill.max);
    if (now !== null && now >= max) return {};
    const to = now === null ? content.scenario.ranges.skill.min : now + 1;
    store.append({ type: "skill_trained", characterId: playerId, skill, to });
    const sign = (v: number) => `${v >= 0 ? "+" : ""}${v}`;
    return { line: `배웠다: ${move.label} ${now === null ? "못 함" : sign(now)} → ${sign(to)}.` };
  }
  if ("delay" in effect) {
    store.append({ type: "time_advanced", activity: "wait", from: state.time, to: state.time + effect.delay });
    // 걸린 시간만큼 바깥에 있었다 (12-98)
    const cold = exposeToCold(ctx, "travel", state.time, state.time + effect.delay);
    exposeToFatigue(ctx, "travel", state.time, state.time + effect.delay);
    const harm = cold.find((d) => d.type === "harm");
    return { line: `시간이 더 걸렸다 (${Math.round(effect.delay / 60)}시간쯤).${harm && harm.type === "harm" ? ` ${harm.trackLabel}: ${harm.fromLabel} → ${harm.toLabel}.` : ""}` };
  }
  if ("lose_item" in effect) {
    const { item } = effect.lose_item;
    const have = state.characters[playerId]!.inventory[item] ?? 0;
    const quantity = Math.min(have, effect.lose_item.quantity);
    if (quantity <= 0) return {};
    store.append({ type: "item_consumed", holder: playerId, itemId: item, quantity });
    return { line: `${josa(`${content.items[item]?.name ?? item} ×${quantity}`, "을/를")} 잃었다.` };
  }
  if ("wear_weapon" in effect) {
    const me = state.characters[playerId];
    const weapon = me ? equippedItem(me, "weapon") : null;
    if (!weapon) return {};
    const broke = wearItem(ctx, playerId, weapon, effect.wear_weapon.amount);
    return { line: broke ?? `${josa(content.items[weapon]?.name ?? weapon, "이/가")} 상했다 (내구도가 줄었다).` };
  }
  if ("take_item" in effect) {
    const { item } = effect.take_item;
    // 판정 결과로 빼앗기는 것은 가진 만큼만 (B7)
    // 주인공 것부터, 모자라면 곁의 동행 것 (플레이 테스트 12)
    let left = effect.take_item.quantity;
    const from: string[] = [];
    for (const holder of playerId === state.playerId ? itemCarriers(state) : [playerId]) {
      const q = Math.min(left, state.characters[holder]?.inventory[item] ?? 0);
      if (q <= 0) continue;
      store.append({ type: "item_consumed", holder, itemId: item, quantity: q });
      if (holder !== state.playerId) from.push(playerCalls(state, content, holder));
      left -= q;
      if (left <= 0) break;
    }
    const quantity = effect.take_item.quantity - left;
    if (quantity <= 0) return {};
    return { line: `${josa(`${content.items[item]?.name ?? item} ×${quantity}`, "을/를")} 내주었다${from.length ? ` (${from.join(", ")}의 것)` : ""}.` };
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
    // 마음이 흔들리는 일은 주인공이 마음 다잡기를 굴린다 (12-220, chance를 쓰지 않는다)
    if (delta > 0 && track === content.scenario.body?.nerves?.track) {
      const shaken = shakeNerves(ctx, delta, reason);
      return { ...(shaken.lines.length ? { line: shaken.lines.join(" ") } : {}), displays: shaken.displays };
    }
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
  if ("mission_goal" in effect) {
    const m = activeMissionOf(state.missions, playerId);
    const index = m ? m.requirements.findIndex((r, i) => "goal" in r && (m.progress[i] ?? 0) < 1) : -1;
    if (!m || index < 0) return {};
    store.append({ type: "mission_requirement_met", missionId: m.id, index });
    const r = m.requirements[index]!;
    return { line: `임무의 결과 조건을 채웠다: ${"goal" in r ? r.goal : ""}` };
  }
  if ("faction_resource" in effect) {
    const { resource, delta } = effect.faction_resource;
    const id = factionRef(state, effect.faction_resource.faction);
    if (!state.factions[id]) return {};
    store.append({ type: "faction_resource_changed", factionId: id, resource, delta });
    return {}; // 창고 사정은 배급과 소문으로만 드러난다
  }
  if ("faction_population" in effect) {
    const id = factionRef(state, effect.faction_population.faction);
    if (!state.factions[id]) return {};
    store.append({ type: "faction_population_changed", factionId: id, delta: effect.faction_population.delta });
    // 우리 무리에 사람이 들었으면 분대가 모자랄 때 확률로 한 명이 분대에 배치된다 (12-190)
    const joined = effect.faction_population.delta > 0 && id === state.characters[playerId]?.factionId ? refugeeToSquad(ctx) : null;
    return joined ? { line: joined } : {}; // 늘어난 입과 손은 배급·산출로 드러난다
  }
  if ("send_to" in effect) {
    const to = effect.send_to;
    // 갇힌 곳에서 다른 곳으로 옮겨지면 빠져나온 것이다 (빼앗긴 것은 두고 온다, 12-55)
    if (heldOf(state.characters[playerId]) && content.locations[to] && state.playerZone !== to) releasePlayer(ctx, false);
    if (!content.locations[to] || state.playerZone === to) return {};
    store.append({ type: "zone_moved", from: state.playerZone, to });
    return { line: `${josa(content.locations[to]!.name, "으로/로")} 옮겨졌다. 함께 있던 인물은 따라오지 않는다.` };
  }
  if ("reveal_tie" in effect) {
    const a = whoOf(ctx, effect.reveal_tie.who, cast);
    const b = whoOf(ctx, effect.reveal_tie.other, cast);
    const tie = a && b ? tiesOf(state, content, a).find((t) => t.other === b) : undefined;
    if (!tie || tieKnown(state, tie)) return {};
    store.append({ type: "tie_revealed", key: tie.key });
    return { line: `알게 된 관계: ${josa(playerCalls(state, content, a!), "은/는")} ${playerCalls(state, content, b!)}의 ${TIE_LABELS[tie.kind]}다.` };
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
    if (heldOf(player)) releasePlayer(ctx, heldOf(player)!.by === faction);
    const role = joinRole(content, faction, rank, { age: player.age, title, occupation: player.occupation?.id ?? null });
    // 그 무리에서 처음 듣는 사정: 같은 계급 시나리오의 시작 지식 (다른 계급의 지식은 주지 않는다)
    const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
    let no = state.nextBeliefNo;
    const beliefs = (preset?.beliefs ?? []).map((b) => ({ id: `b_${no++}`, fact: b.fact, source: b.source === "seen" ? ("report" as const) : b.source, accuracy: b.accuracy, learnedAt: state.time }));
    store.append({ type: "player_joined_faction", factionId: faction, rank: role.rank, role, beliefs });
    const commander = role.commander ? state.characters[role.commander]?.name : undefined;
    // 들어가며 처음 알게 된 이름이면 그렇다고 (플레이 테스트 12: 이름 모르던 분대장이 바로 "상관은 강태호"로 나왔다)
    const newName = !!role.commander && !knowsName(state, state.playerId, role.commander);
    return {
      line:
        `${content.factions[faction]!.name}에 들어갔다 (${role.label}).${commander ? ` 상관은 ${commander}${newName ? " (이제 이름을 안다)" : ""}.` : ""} 이제 이 무리의 배급과 임무를 받는다.` +
        (player.factionId ? ` 전에 있던 무리(${content.factions[player.factionId]?.name ?? player.factionId})의 사람들은 이제 남이다.` : "") +
        (beliefs.length ? ` 이 무리 사정을 ${beliefs.length}가지 들었다 (상태의 믿음).` : ""),
      display: { type: "promotion", name: player.name, fromLabel: from, toLabel: role.label },
    };
  }
  if ("companion_join" in effect) {
    const id = whoOf(ctx, effect.companion_join.who, cast);
    const c = id ? state.characters[id] : undefined;
    if (!id || !c || id === playerId || c.dead || c.away || heldOf(c) || state.companions.includes(id)) return {};
    const template = c.extra?.template ? content.extras[c.extra.template] : undefined;
    const kind = effect.companion_join.kind ?? (template?.kind === "animal" ? "animal" : "purpose");
    const u = effect.companion_join.until;
    const until =
      kind === "purpose"
        ? { ...(u?.flag ? { flag: u.flag } : {}), ...(u?.zone ? { zone: u.zone } : {}), ...(u?.hours || !(u?.flag || u?.zone) ? { at: state.time + (u?.hours ?? 48) * 60 } : {}) }
        : undefined;
    // 임무 이야기로 데려가는 사람은 임무가 끝나면 거점에 넘긴다 (플레이 테스트 13: 데려온 탈영병이 보고 뒤에도 따라다녔다)
    const story = state.activeStorylet ? content.storylets[state.activeStorylet.id] : undefined;
    const forMission = story?.when?.mission?.length ? activeMissionOf(state.missions, playerId)?.id : undefined;
    store.append({ type: "companion_joined", characterId: id, kind, ...(until ? { until } : {}), ...(forMission ? { missionId: forMission } : {}) });
    const name = playerCalls(store.getState(), content, id);
    return { line: `${josa(name, "이/가")} 이제 함께 다닌다 (구역을 옮겨도 따라온다).`, display: { type: "presence", npcName: name, action: "enter" } };
  }
  if ("companion_part" in effect) {
    const id = whoOf(ctx, effect.companion_part.who, cast);
    if (!id || !state.companions.includes(id)) return {};
    if (!state.bonds?.[id]) {
      const t = state.characters[id]?.extra?.template;
      store.append({ type: "companion_bond_changed", characterId: id, kind: t && content.extras[t]?.kind === "animal" ? "animal" : "kin" });
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
    if (!id || !npc || npc.dead || npc.away || heldOf(npc) || id === playerId) return {};
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
    if (!id || !npc || !heldOf(npc)) return {};
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
  // 자리를 떠서 외면으로 처리된 선택지는 행적을 남기지 않는다 (플레이 테스트 13: 지나쳤을 뿐인데 "[자비·적에게 호의] 탈영병을 보내 주었다")
  if ("deed" in effect && blameSuspended()) return {};
  if ("deed" in effect) {
    // GM이 이 장면의 판정(take_action)에서 같은 성격의 행적을 이미 남겼으면 겹쳐 남기지 않는다 (플레이 테스트 8: 같은 일이 두 줄)
    // 이야기가 열린 뒤 GM이 남긴 행적은 성격이 달라도 이 장면의 같은 일이다 (플레이 테스트 11: "들것을 잡고 부상자를 날랐다"가 두 줄)
    const openedAt = state.activeStorylet?.firedAt ?? Infinity;
    // GM이 남긴 행적만 본다 (플레이 테스트 12: 그 사이 시스템이 남긴 "점호 결석"을 같은 일로 집었다)
    const recent = Object.values(state.deeds)
      .filter((d) => d.actorId === playerId && !d.fabricatedBy && !!d.byGm && state.time - d.at <= 60 && (d.tags.some((t) => effect.deed.tags.includes(t)) || d.at >= openedAt))
      .at(-1);
    if (recent) return { line: `행적은 이미 기록됐다: ${sentence(recent.summary)}` };
    const { deed, visible } = recordDeed(ctx, { ...effect.deed, summary: fillStorylet(effect.deed.summary, vars), noisy: false });
    return {
      line: `행적 기록: ${sentence(deed.summary)}${visible.length ? ` 본 사람: ${visible.join(", ")}.` : ""}`,
      display: { type: "deed", summary: deed.summary, tagLabels: deed.tags.map((t) => DEED_TAG_LABELS[t]), visibleWitnesses: visible },
    };
  }
  return {};
}

export const DIALOGUE_STYLES = ["novel", "script"] as const;
export type DialogueStyle = (typeof DIALOGUE_STYLES)[number];
export const DIALOGUE_STYLE_LABELS: Record<DialogueStyle, string> = { novel: "소설", script: "대본" };

export const gameOptionsPatchSchema = z
  .strictObject({
    mature: z.boolean().optional().describe("성인 주제(성인 사이의 잠자리를 암전으로, 성적인 농담·괴롭힘·위협)를 다룬다. 연애는 이것과 상관없이 나온다"),
    dialogue: z.enum(DIALOGUE_STYLES).optional().describe("대화 형식. novel 소설(대사를 서술에 녹인다) / script 대본(대사를 '이름: \"대사\"' 줄로 뗀다)"),
  })
  .refine((x) => x.mature !== undefined || x.dialogue !== undefined, "바꿀 설정을 하나 이상 준다.");
export type GameOptionsPatch = z.infer<typeof gameOptionsPatchSchema>;

/** 세계 설정을 바꾼다 (수위 12-57, 대화 형식 12-63). 바뀐 것만 이벤트로 남긴다. 바뀐 설정을 한 줄씩 */
export function setGameOptions(ctx: ToolContext, patch: GameOptionsPatch): string[] {
  const now = ctx.store.getState().options;
  const event = {
    type: "content_options_set" as const,
    ...(patch.mature !== undefined && patch.mature !== now.mature ? { mature: patch.mature } : {}),
    ...(patch.dialogue !== undefined && patch.dialogue !== now.dialogue ? { dialogue: patch.dialogue } : {}),
  };
  const lines: string[] = [];
  if (event.mature !== undefined) lines.push(event.mature ? "성인 주제를 켰다. 이제 그런 이야기가 열릴 수 있다 (성인끼리만, 장면은 암전)." : "성인 주제를 껐다. 그런 이야기는 열리지 않는다.");
  if (event.dialogue !== undefined) lines.push(`대화 형식을 ${josa(DIALOGUE_STYLE_LABELS[event.dialogue], "으로/로")} 바꿨다. 다음 서술부터 그 형식으로 쓴다.`);
  if (lines.length) ctx.store.append(event);
  return lines;
}

/** 설정을 바꾼다: 플레이어가 성인 주제나 대화 형식을 바꾸겠다고 할 때만 (상태 화면의 설정에서도 바꿀 수 있다) */
export const setContentOptions = defineTool({
  name: "set_content_options",
  description:
    "이 세계의 설정을 바꾼다. mature: 수위 (12-57). 성인 주제(성인 사이의 잠자리는 암전으로, 성적인 농담·괴롭힘·위협)를 다룬다. 연애는 수위와 상관없이 나온다. " +
    "켜져 있어도 미성년자는 어떤 경우에도 그 대상이 아니고, 노골적인 묘사는 하지 않는다. " +
    "dialogue: 대화 형식. novel(소설, 대사를 서술에 녹인다) / script(대본, 대사를 따로 줄로 뗀다). 플레이어가 직접 바꾸겠다고 할 때만 부른다.",
  schema: gameOptionsPatchSchema,
  run(input, ctx) {
    const lines = setGameOptions(ctx, input);
    return {
      ok: true,
      resultText: lines.length ? lines.join(" ") : "이미 그 설정이다.",
      display: { type: "time", activityLabel: "설정", durationLabel: "", fromLabel: "", toLabel: "" },
      silent: true,
    };
  },
});

export const STORYLET_TOOLS = [resolveStorylet, setContentOptions] as const;

/**
 * 길 위의 일 (12-53): 구역을 옮긴 뒤 길의 위험별 확률로 길 위의 이야기 하나를 연다 (이야기 사이 간격과 상관없다).
 * 진행 중인 이야기가 있으면 열지 않는다. 연 이야기의 시작 표시를 돌려준다
 */
export function runRoadEvent(ctx: ToolContext, risk = 1): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const travel = content.scenario.travel;
  const state = store.getState();
  if (!travel || !state.lastRoute || state.activeStorylet || state.battle) return [];
  // 위급할 때나 앞 이야기가 막 열렸을 때는 길 위의 일도 열지 않는다 (12-191)
  const gap = content.scenario.storylet_pacing.min_any_gap_hours * 60;
  if (inCrisis(state, content) || (state.lastStoryletAt !== null && state.lastStoryletAt >= state.runStartedAt && state.time - state.lastStoryletAt < gap)) return [];
  // 탈 것으로 빨리 지나가면 길 위의 일이 덜 생긴다 (12-137)
  const chance = (travel.chance[Math.min(3, routeDanger(content, state))] ?? 0) * risk;
  if (rng() >= chance) return [];
  const storylet = pickStorylet(roadStorylets(state, content, travel.tag), rng);
  if (!storylet) return [];
  const displays = fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!);
  displays.push({ type: "storylet", event: "started", title: storyTitle(store.getState(), content, storylet), detail: setupText(store.getState(), content) });
  return displays;
}

/** 정해진 태그의 이야기 하나를 바로 연다 (D5 몰려든 구역, D6 들킨 침입). 진행 중인 이야기·전투가 있으면 열지 않는다 */
export function runTagEvent(ctx: ToolContext, tag: string): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const state = store.getState();
  if (state.activeStorylet || state.battle) return [];
  // 한 일의 결과라 하루 상한·위협 간격에 걸리지 않는다
  const storylet = pickStorylet(roadStorylets(state, content, tag, state.time, { pacing: false }), rng);
  if (!storylet) return [];
  const displays = fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!);
  displays.push({ type: "storylet", event: "started", title: storyTitle(store.getState(), content, storylet), detail: setupText(store.getState(), content) });
  return displays;
}

/**
 * 소리를 듣고 감염체가 몰려온다 (플레이 테스트 12): 그날 소리가 noise_at에 닿으면 swarm_hours 뒤에 그 구역이 한 단계 오른다.
 * 그때 주인공이 그 구역에 있으면 들어설 때처럼 마주침을 굴린다 (머물러도 아무 일이 없었다)
 */
export function runSwarms(ctx: ToolContext): ToolDisplayEvent[] {
  const rules = ctx.content.scenario.infestation;
  if (!rules?.swarm_hours) return [];
  const [lo, hi] = rules.swarm_hours;
  const out: ToolDisplayEvent[] = [];
  for (const [zone, noise] of Object.entries(ctx.store.getState().zoneNoise)) {
    const state = ctx.store.getState();
    const swarm = state.swarms[zone];
    if (noise.level >= rules.noise_at && (!swarm || swarm.day !== noise.day)) {
      const at = state.time + Math.round((lo + ctx.rng() * Math.max(0, hi - lo)) * 60);
      ctx.store.append({ type: "swarm_set", zone, day: noise.day, at, done: false });
      continue;
    }
    if (!swarm || swarm.done || state.time < swarm.at) continue;
    ctx.store.append({ type: "swarm_set", zone, day: swarm.day, at: swarm.at, done: true });
    // 바리케이드 (12-176): 막힌 길로는 덜 들어온다
    const rise = barrierRise(ctx.content, state, zone);
    if (rise < 1 && ctx.rng() >= rise) continue;
    const now = infestationOf(ctx.content, state, zone);
    if (now < 3) ctx.store.append({ type: "infestation_changed", zone, level: now + 1, cause: "소음" });
    if (state.playerZone === zone && !heldOf(state.characters[state.playerId])) out.push(...runInfestedArrival(ctx, zone));
  }
  return out;
}

/** 몰려든 구역에 들어섰을 때 (D5): 기준값보다 높은 단계 하나당 arrival.per_level 확률 */
export function runInfestedArrival(ctx: ToolContext, zone: string): ToolDisplayEvent[] {
  const rule = ctx.content.scenario.infestation?.arrival;
  if (!rule) return [];
  const excess = infestationOf(ctx.content, ctx.store.getState(), zone) - baseInfestation(ctx.content, zone);
  if (excess <= 0 || ctx.rng() >= excess * rule.per_level) return [];
  return runTagEvent(ctx, rule.tag);
}

/** 적대하는 무리의 땅에서 숨기·몰래 하기가 실패했을 때 (D6) */
export function runAlarm(ctx: ToolContext, move: string): ToolDisplayEvent[] {
  const rule = ctx.content.scenario.alarm;
  if (!rule || !rule.moves.includes(move)) return [];
  const state = ctx.store.getState();
  // 갇혀 있으면 경보 대신 다시 끌려온다 (플레이 테스트 12: 탈출 실패에 "다시 끌려왔다"와 경보 이야기가 함께 열렸다)
  if (pausedWhileHeld(state, "alarm")) return [];
  if (!hostileHere(ctx)) return [];
  const out = runTagEvent(ctx, rule.tag);
  const spotted = out.length ? onSpotted(ctx, state.zones[state.playerZone ?? ""]?.owner ?? null).join(" ") || null : null;
  if (spotted) out.push({ type: "belief", fact: "들켰다. 들키지 않아야 하는 임무였다", sourceLabel: BELIEF_SOURCE_LABELS.seen, note: spotted });
  return out;
}

/** 지금 구역이 주인공을 적대하는 무리의 땅인가 (무소속은 낯선 사람을 잡아가는 무리·현상금을 건 무리의 땅) */
export function hostileHere(ctx: ToolContext): boolean {
  return hostileZone(ctx.store.getState(), ctx.content);
}

export function hostileZone(state: GameState, content: Content): boolean {
  const zone = state.playerZone;
  const owner = zone ? state.zones[zone]?.owner : null;
  const mine = state.characters[state.playerId]?.factionId ?? null;
  if (!owner || owner === mine) return false;
  if (mine) return (state.factions[owner]?.disposition?.[mine] ?? 0) < 0;
  // 무소속: 낯선 사람을 잡아가는 무리(helpless.prey_on_strangers)나 현상금을 건 무리의 땅만 (플레이 테스트 13: 중립 장터·마을에서 말 걸기에도 숨기 판정을 요구하고, 붉은연합 창고는 안전했다)
  return !!content.scenario.helpless?.prey_on_strangers.includes(owner) || (state.bounties ?? []).includes(owner);
}


/**
 * 효과의 무리 자리: own = 주인공의 무리, zone_owner = 지금 구역의 주인 (다투는 땅, 12-54), 그 밖은 세력 id.
 * 주인이 없으면 빈 문자열 (효과가 아무 일도 하지 않는다)
 */
function factionRef(state: GameState, x: string): string {
  if (x === "own") return state.characters[state.playerId]?.factionId ?? "";
  if (x === "zone_owner") return (state.playerZone && state.zones[state.playerZone]?.owner) || "";
  if (x === "captor") return heldOf(state.characters[state.playerId])?.by ?? "";
  if (x === "bounty") return state.bounties[0] ?? "";
  return x;
}
