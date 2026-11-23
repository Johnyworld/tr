import { stakesOf } from "../rules/stakes.ts";
import { ableNow } from "../rules/company.ts";
import { heldOf } from "../rules/held.ts";
import { profileOf } from "./people.ts";
import { fameOf } from "../game/fame.ts";
import { isCreature } from "../game/kinds.ts";
import { weatherNow } from "../sim/weather.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { valuesOf } from "./extras.ts";
import { alertnessFactor, effectiveSkill, noticedFactor, rumorFactor, traitSkillMod } from "./traits.ts";
import { withCharm } from "./charm.ts";
import { josa, sentence } from "../text.ts";
import { z } from "zod";
import { dayOf } from "../rules/time.ts";
import type { BeliefSource } from "../game/belief.ts";
import type { GameState } from "../game/state.ts";
import type { Character } from "../game/character.ts";
import {
  computeRelationDelta,
  DEED_TAG_LABELS,
  deedTagSchema,
  hiddenWitnessChance,
  privacySchema,
  spreadOneDay,
  type Deed,
  type DeedTag,
  type Privacy,
} from "../game/reputation.ts";
import { rollPlayerCheck } from "./checks.ts";
import { knowsName } from "../game/acquaintance.ts";
import { tiesOf } from "../game/ties.ts";
import { loversOf } from "./romance.ts";
import { isIncapacitated } from "./body.ts";
import { moveOf } from "../scenario/scenario.ts";
import { tellPlayerSecret } from "../rules/self.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";
import {sharesPlace, whereIs, zoneOf, hereWithMe, peopleHere } from "../rules/place.ts";

export type DeedInput = {
  summary: string;
  tags: DeedTag[];
  severity: number;
  privacy: Privacy;
  noisy: boolean;
  byGm?: boolean;
  /** 당한 사람 (12-262): 가치관으로 마음이 오르지 않는다 (원망은 공통 규칙 13 wrongedResentment) */
  victim?: string | null;
};

/** 이번 턴 플레이어의 은밀 행동 판정 중 가장 좋은 결과 (은밀 행동은 시나리오의 move_roles.stealth) */
function stealthThisTurn(state: GameState, stealthMove: string): "success" | "partial" | "miss" | null {
  const outcomes = Object.values(state.checks)
    .filter((c) => c.turn === state.turn && c.actorId === state.playerId && c.move === stealthMove)
    .map((c) => c.outcome);
  return outcomes.includes("success") ? "success" : outcomes.includes("partial") ? "partial" : outcomes[0] ?? null;
}

/**
 * 장면에 있는 사람 가운데 이 일을 보는 사람 (PT15 졸병: 은밀 13으로 성공한 도둑질을 장면의 모두가 "보았다").
 * 이번 턴 은밀이 성공했으면 아무도 못 보고, 대가 있는 성공이면 그 은밀에 맞선 상대·대상만 본다. 실패했거나 은밀이 없으면 모두 본다
 */
function sceneSees(state: GameState, stealthMove: string, npcId: string): boolean {
  const stealth = stealthThisTurn(state, stealthMove);
  if (stealth === "success") return false;
  if (stealth !== "partial") return true;
  return Object.values(state.checks).some((c) => c.turn === state.turn && c.actorId === state.playerId && c.move === stealthMove && (c.opponent === npcId || c.target === npcId));
}

/** 같은 장소에 있는 숨은 목격자의 배수 (B②). 상한은 MAX_NOTICE */
export const SAME_PLACE_FACTOR = 2;
const MAX_NOTICE = 0.95;

/** 장면 밖 한 사람이 지금 주인공이 하는 일을 알아차릴 확률 (숨은 목격자·장소에 들어설 때 같이 쓴다) */
function noticeChance(ctx: ToolContext, character: Character, privacy: Privacy, noisy: boolean, stealth: "success" | "partial" | "miss" | null): number {
  const state = ctx.store.getState();
  const scenario = ctx.content.scenario;
  const notice = noticeMove(ctx);
  return Math.min(
    MAX_NOTICE,
    hiddenWitnessChance({
      privacy,
      time: state.time,
      noisy,
      // 그 인물의 주의력: 감각 능력 + 경계 스킬 (상한까지)
      senseStat: Math.min(scenario.ranges.cap, (character.stats[notice.stats[0]!] ?? 0) + effectiveSkill(ctx.content, character, notice.id)),
      // 트레잇: 목격하는 쪽의 주의력, 하는 쪽이 눈에 띄는지
      traitFactor: alertnessFactor(ctx.content, character) * noticedFactor(ctx.content, state.characters[state.playerId]!),
      stealth,
      visibility: weatherNow(scenario, state)?.visibility ?? 1,
    }),
  );
}

/**
 * 적 땅의 장소에 들어서자 그곳의 땅 주인 무리 사람이 알아보았는가 (B②, PT19 졸병: 대낮에 마당을 가로질러 수용소 철망 앞까지 가도 그 자리의 다섯이 보지 않았다).
 * 그 장소에 있을 사람(장면 밖) 가운데 그 무리이고 움직일 수 있는 사람이 드러난 곳(public)으로 한 번씩 굴린다. 이번 턴 은밀이 성공·대가 있는 성공이면 덜 본다.
 * 본 사람 id를 돌려준다 (경보는 부르는 쪽이 연다)
 */
export function spottedEntering(ctx: ToolContext, owner: string): string[] {
  const state = ctx.store.getState();
  const stealth = stealthThisTurn(state, ctx.content.scenario.move_roles.stealth);
  return peopleHere(state, ctx.content).filter((id) => {
    const c = state.characters[id];
    if (!c || c.factionId !== owner || isCreature(ctx.content, c) || !ableNow(state, ctx.content, id)) return false;
    return ctx.rng() < noticeChance(ctx, c, "public", false, stealth);
  });
}

/** 낌새를 알아차리는 행동 (시나리오의 move_roles.notice). 첫 번째 능력치를 쓴다 */
function noticeMove(ctx: ToolContext) {
  const s = ctx.content.scenario;
  return moveOf(s, s.move_roles.notice)!;
}

/** NPC가 행적을 알게 한다 (관계 변화는 그 NPC의 가치관으로 코드가 계산) */
/** 행적으로 오르는 관계는 축마다 하루 +1까지 (플레이 테스트 11, C6). 떨어지는 쪽은 자르지 않는다 */
export const DAILY_REGARD_GAIN = 1;

export function learn(ctx: ToolContext, deed: Deed, npcId: string, source: BeliefSource, only?: readonly ("trust" | "affection" | "respect")[]) {
  const state = ctx.store.getState();
  const values = valuesOf(ctx.content, state, npcId);
  // "적에게 호의"는 우리 편이 보기에만 흠이다. 호의를 받은 쪽(적·포로)에게까지 신뢰를 깎았다 (플레이 테스트 11)
  const actorFaction = state.characters[deed.actorId]?.factionId;
  const witness = state.characters[npcId];
  const ownSide = !!actorFaction && witness?.factionId === actorFaction && !heldOf(witness);
  const tags = ownSide ? deed.tags : deed.tags.filter((t) => t !== "enemy_sympathy");
  const raw = withCharm(ctx, npcId, deed.actorId, computeRelationDelta(values, tags, deed.severity, source));
  const today = state.regardGained.day === dayOf(state.time) ? (state.regardGained.by[npcId]?.[deed.actorId] ?? {}) : {};
  const delta = { ...raw };
  for (const axis of ["trust", "affection", "respect"] as const) {
    if (only && !only.includes(axis)) delta[axis] = Math.min(0, delta[axis]);
    if (delta[axis] > 0) delta[axis] = Math.min(delta[axis], Math.max(0, DAILY_REGARD_GAIN - (today[axis] ?? 0)));
  }
  ctx.store.append({ type: "deed_learned", deedId: deed.id, npcId, source, delta });
}

/**
 * 플레이어의 행적을 기록하고 목격자를 정한다 (기획서 8.1~8.2).
 * - 장면에 있는 NPC는 모두 본다 (보이는 목격자)
 * - 장면에 없는 NPC는 노출도·시간대·소음·주의력·은밀 행동으로 굴린다 (숨은 목격자)
 * official을 주면 그 NPC만 알고 숨은 목격자를 굴리지 않는다 (임무 보고처럼 공식적인 일)
 * fooled를 주면 속이기가 먹힌 것이다: 그 사람들은 속아 넘어가 행적(거짓말했다)을 알지 못하고, 숨은 목격자도 굴리지 않는다
 * (PT14: 거짓말 판정이 성공해도 속은 상대가 "직접 봄"으로 거짓말을 알았고, 상관의 믿음을 잃은 일로 보였다)
 */
export function recordDeed(
  ctx: ToolContext,
  input: DeedInput,
  official?: { npcId: string; source: BeliefSource; only?: readonly ("trust" | "affection" | "respect")[] },
  fooled?: readonly string[],
): { deed: Deed; visible: string[] } {
  return recordDeedIf(ctx, input, official, fooled, false) as { deed: Deed; visible: string[] };
}

/**
 * 본 사람이 있을 때만 행적을 남긴다 (PT15 졸병: 장면에 아무도 없고 숨은 목격자도 없는데 "들켰다" 불복종이 남았다).
 * 아무도 못 봤으면 deed는 null
 */
export function recordDeedIfSeen(ctx: ToolContext, input: DeedInput): { deed: Deed | null; visible: string[] } {
  return recordDeedIf(ctx, input, undefined, undefined, true);
}

function recordDeedIf(
  ctx: ToolContext,
  input: DeedInput,
  official: { npcId: string; source: BeliefSource; only?: readonly ("trust" | "affection" | "respect")[] } | undefined,
  fooled: readonly string[] | undefined,
  onlyIfSeen: boolean,
): { deed: Deed | null; visible: string[] } {
  const state = ctx.store.getState();
  const id = `d_${state.nextDeedNo}`;
  const witnesses: Deed["witnesses"] = [];

  if (official) {
    witnesses.push({ npcId: official.npcId, hidden: !state.scene.present.includes(official.npcId) });
  } else {
    // 동물·감염체는 행적을 보고 옮기지 않는다 (12-111)
    const scenario = ctx.content.scenario;
    // 볼 수 있는 사람만: 죽은 사람·기절한 사람·갇힌 사람은 보지 못한다 (공통 규칙 7·8, 12-269 우회 점검: 기절시킨 경비가 "보았다"로 경보를 울렸다)
    for (const npcId of state.scene.present) if (!isCreature(ctx.content, state.characters[npcId]) && ableNow(state, ctx.content, npcId) && !fooled?.includes(npcId) && sceneSees(state, scenario.move_roles.stealth, npcId)) witnesses.push({ npcId, hidden: false });
    const stealth = stealthThisTurn(state, scenario.move_roles.stealth);
    for (const character of fooled ? [] : Object.values(state.characters)) {
      if (character.id === state.playerId || character.dead || character.away || heldOf(character)) continue;
      // 엑스트라는 같은 장소에 있다고 정해진 사람만 (집·머무는 자리): 어디 있는지 모르는 엑스트라는 굴리지 않는다
      // (12-268, PT18·PT19 졸병: 적 지휘소의 정비공·장교 엑스트라가 장면에 없으면 절대 보지 못했다)
      if (state.scene.present.includes(character.id) || isCreature(ctx.content, character)) continue;
      if (!ctx.content.npcs[character.id] && !hereWithMe(state, ctx.content, character.id)) continue;
      // 숨은 목격자는 그 시각 같은 구역에 있던 사람만 (기획서 8.2 "근처"). 전에는 세계 어디에 있든 굴려,
      // 다른 무리 거점의 약사가 우리 거점 안의 일을 "직접 봄"으로 알았다 (플레이 테스트 8)
      // (어디 있는지 모르는 인물이나 구역이 없는 장면은 예전처럼 굴린다)
      const where = zoneOf(state, ctx.content, character.id);
      if (state.playerZone && where && where !== state.playerZone) continue;
      // 같은 구역이어도 다른 장소에 있을 사람은 보지 못한다 (공통 규칙 15, PT14: 장터 반대편·다른 장소의 사람이 "직접 봄")
      if (!sharesPlace(state, ctx.content, character.id)) continue;
      // 같은 장소에 있다고 정해진 사람은 두 배로 본다 (B② 2026-11-23, PT16·17 졸병: 창고에 있을 사람 여섯인데 장면의 하나만 보았다).
      // 장소를 모르는 "구역 어딘가"의 사람은 그대로
      const chance = noticeChance(ctx, character, input.privacy, input.noisy, stealth) * (hereWithMe(state, ctx.content, character.id) ? SAME_PLACE_FACTOR : 1);
      if (ctx.rng() < chance) witnesses.push({ npcId: character.id, hidden: true });
    }
  }

  if (onlyIfSeen && witnesses.length === 0) return { deed: null, visible: [] };
  const deed: Deed = {
    id,
    actorId: state.playerId,
    summary: input.summary,
    tags: input.tags,
    severity: input.severity,
    at: state.time,
    witnesses,
    searched: false,
    ...(input.byGm ? { byGm: true } : {}),
  };
  ctx.store.append({ type: "deed_recorded", deed });
  for (const w of witnesses) learn(ctx, deed, w.npcId, official?.source ?? "seen", w.npcId === input.victim ? [] : official?.only);

  const visible = witnesses.filter((w) => !w.hidden).map((w) => playerCalls(state, ctx.content, w.npcId));
  return { deed, visible };
}

const lookForWitnesses = defineTool({
  name: "look_for_witnesses",
  description:
    "플레이어 캐릭터가 방금 한 일을 누가 보지 않았는지 주변을 살핀다 (낌새를 알아차리는 판정을 시스템이 굴린다). " +
    "행적 하나에 한 번만 살필 수 있다. 성공하면 누가 봤는지, 대가 있는 성공이면 누군가 본 것 같다는 느낌만, 실패하면 아무것도 모른다.",
  schema: z.strictObject({
    deed_id: z.string().describe("살펴볼 행적 id (take_action 결과에 나온 행적 id)"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const deed = state.deeds[input.deed_id];
    if (!deed || deed.actorId !== state.playerId) return { ok: false, error: `알 수 없는 행적: ${input.deed_id}` };
    if (deed.searched) return { ok: false, error: "이미 살펴본 행적입니다." };
    if (state.time - deed.at > 60) return { ok: false, error: "너무 오래전 일이라 살필 수 없습니다." };

    const check = rollPlayerCheck(
      {
        move: noticeMove(ctx).id,
        stat: noticeMove(ctx).stats[0]!,
        difficulty: "normal",
        intent: "누가 보지 않았는지 주변을 살핀다",
      },
      ctx,
      { stakes: stakesOf({ activity: true }) },
    );
    if (!check.ok) return check;
    ctx.store.append({ type: "witnesses_searched", deedId: deed.id });
    const growthNote = check.growthNote;

    const hidden = deed.witnesses.filter((w) => w.hidden).map((w) => playerCalls(state, ctx.content, w.npcId));
    let finding: string;
    if (check.outcome === "success") {
      finding = hidden.length > 0 ? `${josa(hidden.join(", "), "이/가")} 보고 있었다.` : "아무도 보지 않았다.";
    } else if (check.outcome === "partial") {
      finding = hidden.length > 0 ? "누군가 본 것 같다. 누군지는 모르겠다." : "누가 봤는지 확신할 수 없다.";
    } else {
      finding = "";
    }
    if (finding) {
      ctx.store.append({
        type: "belief_added",
        characterId: state.playerId,
        belief: {
          id: `b_${ctx.store.getState().nextBeliefNo}`,
          // "내가 했는지"가 아니라 "누가 봤는지"에 대한 믿음이다
          fact: `${sentence(deed.summary)} 그때 주변을 살폈다: ${finding}`,
          source: "seen",
          accuracy: check.outcome === "success" ? "exact" : "approximate",
          learnedAt: state.time,
        },
      });
    }
    const extra: ToolDisplayEvent[] = finding ? [{ type: "belief", fact: finding, sourceLabel: "직접 봄" }] : [];
    return {
      ok: true,
      resultText:
        `주변 살피기 판정 ${check.checkId}: ${check.display.outcomeLabel} (주사위 ${check.dice[0]}+${check.dice[1]}, 보정 ${check.modifier >= 0 ? "+" : ""}${check.modifier}, 합계 ${check.total}). ` +
        `${finding || "아무것도 알아내지 못했다 (누가 봤는지 여부도 모른다)."} 이 결과대로 서술하라.` + (growthNote ? `\n${growthNote}` : ""),
      display: check.display,
      extra,
    };
  },
});

/** 누명이 들켰을 때 주인공의 행적 */
const caughtSummary = (who: string) => `${who}에 대해 거짓말을 퍼뜨리려다 들켰다`;

const revealSecret = defineTool({
  name: "reveal_secret",
  description:
    "장면에 있는 인물이 플레이어에게 비밀을 털어놓는다. <상태>에 그 인물이 '비밀을 털어놓을 수 있는 관계'라고 표시되고, " +
    "공개 상황이 맞을 때만 쓴다. 비밀의 내용은 시스템이 결과로 알려 준다. " +
    "own: true면 거꾸로 주인공이 자기 비밀(설정)을 npc_id에게 털어놓는다: 그 인물과 그 자리에 있던 사람이 알게 된다 (플레이어가 털어놓겠다고 할 때만).",
  schema: z.strictObject({ npc_id: z.string(), own: z.boolean().default(false) }),
  run(input, ctx) {
    const state = ctx.store.getState();
    if (input.own) {
      const told = tellPlayerSecret(ctx, input.npc_id);
      if (!told.ok) return told;
      const names = told.told.map((id) => playerCalls(state, ctx.content, id));
      return {
        ok: true,
        resultText: `당신의 비밀을 ${names.length > 1 ? `${josa(names.join(", "), "과/와")} 함께 있는 자리에서` : `${names.join(", ")}에게`} 털어놓았다: ${told.fact}\n이제 ${josa(names.join(", "), "은/는")} 안다. 각자의 성격·관계대로 반응을 서술하라 (호감·신뢰는 바뀌지 않는다, 바뀌면 이후 행동으로).`,
        display: { type: "belief", fact: `털어놓은 비밀: ${told.fact}`, sourceLabel: "고백" },
        silent: true,
      };
    }
    // 콘텐츠 인물이든 자란 인물이든 (기획서 7.10)
    const profile = profileOf(state, ctx.content, input.npc_id);
    if (!profile || !state.scene.present.includes(input.npc_id)) return { ok: false, error: "장면에 없는 인물입니다." };
    const npc = { id: input.npc_id, secret: profile.secret };
    const called = playerCalls(state, ctx.content, npc.id);
    if (!npc.secret) return { ok: false, error: `${josa(called, "은/는")} 털어놓을 비밀이 없다.` };
    if (state.revealedSecrets.includes(npc.id)) return { ok: false, error: "이미 털어놓은 비밀이다." };
    const trust = state.relations[npc.id]?.[state.playerId]?.trust ?? 0;
    if (trust < npc.secret.min_trust) return { ok: false, error: `${josa(called, "은/는")} 아직 그만큼 당신을 믿지 않는다.` };

    ctx.store.append({ type: "secret_revealed", npcId: npc.id });
    const fact = `${called}의 고백: ${npc.secret.content}`;
    ctx.store.append({
      type: "belief_added",
      characterId: state.playerId,
      belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact, source: "report", accuracy: "exact", learnedAt: state.time },
    });
    return {
      ok: true,
      resultText: `${josa(called, "이/가")} 털어놓는다: ${npc.secret.content}\n이 인물의 말투와 성격대로, 망설임과 감정을 담아 서술하라.`,
      display: { type: "belief", fact, sourceLabel: "고백" },
    };
  },
});

/** 지어낸 행적 하나의 크기 상한과 같은 대상에게 다시 퍼뜨릴 수 있는 간격 (12-151) */
const RUMOR_EVERY_DAYS = 1;

/**
 * 거짓 소문 퍼뜨리기·누명 (기획서 8.9, 12-151). 판정은 월드의 move_roles.deceive.
 * 성공·대가 있는 성공이면 지어낸 행적(그 사람이 하지 않은 일)이 장면의 듣는 사람들에게 "전해 들음"으로 들어가고, 그 뒤로는 행적 전파 규칙 그대로 퍼진다.
 * 대가 있는 성공이면 듣던 한 사람이 출처를 기억하고(주인공의 거짓말 행적, 그 사람만 안다), 실패면 아무도 믿지 않고 그 자리 모두가 주인공의 거짓말을 본다
 */
const spreadRumor = defineTool({
  name: "spread_rumor",
  description:
    "거짓 소문을 퍼뜨린다 (누명 씌우기). 플레이어가 장면에 있는 사람들에게, 이름 있는 인물이 하지 않은 일을 했다고 말할 때만 쓴다 (진짜 본 일을 전할 때는 쓰지 않는다). " +
    "판정은 시스템이 굴린다. 대상과 가까운 사람(가족·친구·연인)이 듣는 자리면 어렵다. 믿으면 그 말은 그 사람의 행적처럼 퍼지고, 듣는 사람마다 가치관대로 그 사람을 보는 눈이 바뀐다. " +
    "실패하면 거짓말한 것이 드러난다. 같은 사람에게는 하루에 한 번.",
  schema: z.strictObject({
    about: z.string().describe("누명을 씌울 인물 id (이름 있는 인물. 장면에 없어도 된다)"),
    summary: z.string().min(1).max(120).describe("지어낸 일 한 줄 (예: 보급 창고에서 통조림을 빼돌렸다)"),
    tags: z.array(deedTagSchema).min(1).max(3).describe("지어낸 일의 성격 (행적 태그)"),
    severity: z.number().int().min(1).max(3).describe("지어낸 일의 크기 1~3"),
  }),
  run(input, ctx) {
    const { store, content } = ctx;
    const state = store.getState();
    const move = content.scenario.move_roles.deceive;
    if (!move) return { ok: false, error: "이 월드에는 소문을 지어낼 규칙이 없다." };
    const me = state.characters[state.playerId]!;
    const target = state.characters[input.about];
    if (!target || target.id === me.id || isCreature(content, target)) return { ok: false, error: `알 수 없는 인물: ${input.about}` };
    if (!knowsName(state, me.id, target.id)) return { ok: false, error: "이름을 아는 사람에게만 누명을 씌울 수 있다." };
    const listeners = state.scene.present.filter((id) => {
      const c = state.characters[id];
      return id !== target.id && c && !isCreature(content, c) && ableNow(state, content, id) && !isIncapacitated(content, c);
    });
    if (!listeners.length) return { ok: false, error: "들을 사람이 없다. 장면에 누명을 쓸 사람 말고 다른 사람이 있어야 한다." };
    const today = dayOf(state.time);
    // 지어낸 말이 통했든 들켰든, 같은 사람에 대한 말은 하루 한 번
    const caught = caughtSummary(playerCalls(state, content, target.id));
    const again = Object.values(state.deeds).some(
      (d) => today - dayOf(d.at) < RUMOR_EVERY_DAYS && ((d.fabricatedBy === me.id && d.actorId === target.id) || (d.actorId === me.id && d.summary === caught)),
    );
    if (again) return { ok: false, error: `${playerCalls(state, content, target.id)}에 대한 말은 오늘 이미 퍼뜨렸다.` };
    // 대상과 이어진 사람(가족·친구·연인)이 듣는 자리면 어렵다
    const close = new Set([...tiesOf(state, content, target.id).filter((t) => t.kind !== "rival").map((t) => t.other), ...loversOf(state, content, target.id)]);
    const hard = listeners.some((id) => close.has(id));
    const m = moveOf(content.scenario, move)!;
    const check = rollPlayerCheck(
      { move, stat: m.stats[0]!, difficulty: hard ? "hard" : "normal", intent: `${playerCalls(state, content, target.id)}에 대해 지어낸 말을 퍼뜨린다` },
      ctx,
      { target: listeners[0]!, stakes: stakesOf({ opponent: true }) },
    );
    if (!check.ok) return check;
    const who = playerCalls(state, content, target.id);
    const lines: string[] = [];
    if (check.outcome !== "miss") {
      const now = store.getState();
      const deed: Deed = {
        id: `d_${now.nextDeedNo}`,
        actorId: target.id,
        summary: input.summary,
        tags: input.tags,
        severity: input.severity,
        at: now.time,
        witnesses: [],
        searched: false,
        fabricatedBy: me.id,
      };
      store.append({ type: "deed_recorded", deed });
      for (const id of listeners) learn(ctx, deed, id, "report");
      lines.push(`${josa(listeners.map((id) => playerCalls(state, content, id)).join(", "), "이/가")} ${who}에 대한 말을 믿었다. 이제 이 말은 ${who}의 일처럼 퍼진다.`);
      if (check.outcome === "partial") {
        const doubter = listeners[Math.floor(ctx.rng() * listeners.length)]!;
        recordDeed(ctx, { summary: `${who}에 대한 말을 지어냈다`, tags: ["deceit"], severity: 1, privacy: "private", noisy: false }, { npcId: doubter, source: "seen" });
        lines.push(`다만 ${josa(playerCalls(state, content, doubter), "은/는")} 이 말이 어디서 나왔는지 기억한다 (속으로 의심한다. 드러낼지는 성격대로).`);
      }
    } else {
      recordDeed(ctx, { summary: caughtSummary(who), tags: ["deceit", "betrayal"], severity: 1, privacy: "semi_private", noisy: false });
      lines.push(`아무도 믿지 않았다. 거짓말인 것이 드러났다 (그 자리 사람들이 당신을 보는 눈이 바뀐다).`);
    }
    return {
      ok: true,
      resultText:
        `거짓 소문 판정 ${check.checkId}: ${check.display.outcomeLabel}${hard ? ` (${josa(who, "과/와")} 가까운 사람이 듣고 있어 어렵다)` : ""}. ${lines.join(" ")} 이 결과대로 서술하라.` +
        (check.growthNote ? `\n${check.growthNote}` : ""),
      display: check.display,
    };
  },
});

export const REPUTATION_TOOLS = [lookForWitnesses, revealSecret, spreadRumor] as const;

/**
 * 하루 단위 소문 전파 (기획서 8.4). 턴 시작에 날이 바뀌었으면 지난 날 수만큼(최대 3일) 1단계씩 퍼진다.
 * 결과는 플레이어에게 보이지 않는다. 관계 변화로만 드러난다.
 */
export function spreadRumors(ctx: ToolContext): void {
  const day = dayOf(ctx.store.getState().time);
  const last = ctx.store.getState().lastSpreadDay;
  if (last === null) {
    ctx.store.append({ type: "rumors_spread", day });
    return;
  }
  if (day <= last) return;
  for (let d = last + 1; d <= Math.min(day, last + 3); d++) {
    const state = ctx.store.getState();
    const npcIds = Object.values(state.characters)
      .filter((c) => c.id !== state.playerId && !c.dead && !c.away && !heldOf(c) && ctx.content.npcs[c.id])
      .map((c) => c.id);
    // 명성 (12-127): 무명이면 목격자의 무리 안에서만, 알려지면 말이 모이는 곳을 거쳐 다른 무리로, 이름나면 소문으로 들은 사람도 옮긴다
    const fame = ctx.content.scenario.fame;
    const talk = ctx.content.scenario.war?.talk?.rumor?.zones ?? [];
    const tierOf = new Map<string, number>();
    const tier = (actor: string) => tierOf.get(actor) ?? (tierOf.set(actor, fameOf(state, ctx.content, actor).tier), tierOf.get(actor)!);
    const zoneAt = (id: string) => (ctx.content.npcs[id] ? (whereIs(state, ctx.content, id)?.zone ?? undefined) : undefined);
    const learned = spreadOneDay({
      deeds: Object.values(state.deeds),
      knowledge: state.deedKnowledge,
      npcIds,
      spreadFactor: (id) => {
        const c = ctx.store.getState().characters[id];
        return c ? rumorFactor(ctx.content, c) : 1;
      },
      rng: ctx.rng,
      ...(fame
        ? {
            canPass: (deed, teller, listener) => {
              const a = state.characters[teller]?.factionId;
              if (a && a === state.characters[listener]?.factionId) return true;
              const zone = zoneAt(listener);
              return tier(deed.actorId) >= fame.cross_from && !!zone && talk.includes(zone);
            },
            relayRumor: (deed) => tier(deed.actorId) >= fame.relay_from,
          }
        : {}),
    });
    for (const l of learned) learn(ctx, state.deeds[l.deedId]!, l.npcId, l.source);
  }
  ctx.store.append({ type: "rumors_spread", day });
}
