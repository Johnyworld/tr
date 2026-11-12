import { z } from "zod";
import { dayOf } from "../rules/time.ts";
import type { BeliefSource } from "../game/belief.ts";
import type { GameState } from "../game/state.ts";
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
import { moveOf } from "../scenario/scenario.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

export type DeedInput = {
  summary: string;
  tags: DeedTag[];
  severity: number;
  privacy: Privacy;
  noisy: boolean;
};

/** 이번 턴 플레이어의 은밀 행동 판정 중 가장 좋은 결과 (은밀 행동은 시나리오의 move_roles.stealth) */
function stealthThisTurn(state: GameState, stealthMove: string): "success" | "partial" | "miss" | null {
  const outcomes = Object.values(state.checks)
    .filter((c) => c.turn === state.turn && c.actorId === state.playerId && c.move === stealthMove)
    .map((c) => c.outcome);
  return outcomes.includes("success") ? "success" : outcomes.includes("partial") ? "partial" : outcomes[0] ?? null;
}

/** 낌새를 알아차리는 행동 (시나리오의 move_roles.notice). 첫 번째 능력치를 쓴다 */
function noticeMove(ctx: ToolContext) {
  const s = ctx.content.scenario;
  return moveOf(s, s.move_roles.notice)!;
}

/** NPC가 행적을 알게 한다 (관계 변화는 그 NPC의 가치관으로 코드가 계산) */
function learn(ctx: ToolContext, deed: Deed, npcId: string, source: BeliefSource) {
  const npc = ctx.content.npcs[npcId];
  const delta = computeRelationDelta(npc?.values ?? {}, deed.tags, deed.severity, source);
  ctx.store.append({ type: "deed_learned", deedId: deed.id, npcId, source, delta });
}

/**
 * 플레이어의 행적을 기록하고 목격자를 정한다 (기획서 8.1~8.2).
 * - 장면에 있는 NPC는 모두 본다 (보이는 목격자)
 * - 장면에 없는 NPC는 노출도·시간대·소음·주의력·은밀 행동으로 굴린다 (숨은 목격자)
 * official을 주면 그 NPC만 알고 숨은 목격자를 굴리지 않는다 (임무 보고처럼 공식적인 일)
 */
export function recordDeed(
  ctx: ToolContext,
  input: DeedInput,
  official?: { npcId: string; source: BeliefSource },
): { deed: Deed; visible: string[] } {
  const state = ctx.store.getState();
  const id = `d_${state.nextDeedNo}`;
  const witnesses: Deed["witnesses"] = [];

  if (official) {
    witnesses.push({ npcId: official.npcId, hidden: !state.scene.present.includes(official.npcId) });
  } else {
    for (const npcId of state.scene.present) witnesses.push({ npcId, hidden: false });
    const scenario = ctx.content.scenario;
    const stealth = stealthThisTurn(state, scenario.move_roles.stealth);
    const noticeStat = noticeMove(ctx).stats[0]!;
    for (const character of Object.values(state.characters)) {
      if (character.id === state.playerId || character.dead) continue;
      if (state.scene.present.includes(character.id) || !ctx.content.npcs[character.id]) continue;
      const chance = hiddenWitnessChance({
        privacy: input.privacy,
        time: state.time,
        noisy: input.noisy,
        senseStat: character.stats[noticeStat] ?? 0,
        stealth,
      });
      if (ctx.rng() < chance) witnesses.push({ npcId: character.id, hidden: true });
    }
  }

  const deed: Deed = {
    id,
    actorId: state.playerId,
    summary: input.summary,
    tags: input.tags,
    severity: input.severity,
    at: state.time,
    witnesses,
    searched: false,
  };
  ctx.store.append({ type: "deed_recorded", deed });
  for (const w of witnesses) learn(ctx, deed, w.npcId, official?.source ?? "seen");

  const visible = witnesses.filter((w) => !w.hidden).map((w) => state.characters[w.npcId]?.name ?? w.npcId);
  return { deed, visible };
}

const recordDeedTool = defineTool({
  name: "record_deed",
  description:
    "플레이어 캐릭터가 남들이 알면 평판이 달라질 행동을 했을 때 기록한다 (도둑질, 거짓말, 자비, 잔혹, 명령 위반, 용기, 비겁, 동료를 위함·배신 등). " +
    "목격자와 소문, 사람들의 반응은 시스템이 정한다. 사소한 행동이나 아무 의미 없는 행동은 기록하지 않는다. " +
    "결과가 불확실한 행동이면 판정을 먼저 하고, 실제로 일어난 일만 기록한다. " +
    "행동 하나는 한 번만 기록한다. <상태>의 '이미 기록된 당신의 행적'에 있는 행동은 결과가 이어지더라도 다시 기록하지 않는다. " +
    "summary에는 플레이어가 한 행동만 쓰고, 들켰는지 같은 결과는 쓰지 않는다 (목격은 시스템이 정한다).",
  schema: z.strictObject({
    summary: z.string().min(1).max(120).describe("무슨 일을 했는지 한 문장 (예: 창고 뒷문으로 들어가 통조림 두 개를 훔쳤다)"),
    tags: z.array(deedTagSchema).min(1).max(3).describe(
      "행동의 성격: diligence 성실, disobedience 명령 불복종, mercy 자비, cruelty 잔혹, theft 도둑질, deceit 거짓말, honesty 정직, bravery 용기, cowardice 비겁, loyalty 동료를 위함, betrayal 배신, selfishness 제 몫 챙기기, enemy_sympathy 적에게 호의",
    ),
    severity: z.number().int().min(1).max(3).describe("심각도: 1 사소함, 2 눈에 띔, 3 중대함"),
    privacy: privacySchema.describe("장소의 노출도: public 사람이 많은 곳, semi_private 한적한 곳, private 아무도 없을 만한 곳"),
    noisy: z.boolean().describe("총성·비명·큰 소리가 났는지"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    if (state.characters[state.playerId]?.dead) return { ok: false, error: "사망한 캐릭터입니다." };
    const { deed, visible } = recordDeed(ctx, input);
    return {
      ok: true,
      resultText:
        `행적 ${deed.id} 기록: ${deed.summary}. ` +
        (visible.length > 0
          ? `장면에 있던 ${visible.join(", ")}이(가) 보았다. 그들의 반응을 서술에 반영하라.`
          : "장면에 아무도 없었다.") +
        " 숨은 목격자가 있었는지는 아무도 모른다. 플레이어가 주변을 살피면 look_for_witnesses를 쓴다.",
      display: {
        type: "deed",
        summary: deed.summary,
        tagLabels: deed.tags.map((t) => DEED_TAG_LABELS[t]),
        visibleWitnesses: visible,
      },
    };
  },
});

const lookForWitnesses = defineTool({
  name: "look_for_witnesses",
  description:
    "플레이어 캐릭터가 방금 한 일을 누가 보지 않았는지 주변을 살핀다 (낌새를 알아차리는 판정을 시스템이 굴린다). " +
    "행적 하나에 한 번만 살필 수 있다. 성공하면 누가 봤는지, 대가 있는 성공이면 누군가 본 것 같다는 느낌만, 실패하면 아무것도 모른다.",
  schema: z.strictObject({
    deed_id: z.string().describe("살펴볼 행적 id (record_deed 결과에 나온 것)"),
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
    );
    if (!check.ok) return check;
    ctx.store.append({ type: "witnesses_searched", deedId: deed.id });

    const hidden = deed.witnesses.filter((w) => w.hidden).map((w) => state.characters[w.npcId]?.name ?? w.npcId);
    let finding: string;
    if (check.outcome === "success") {
      finding = hidden.length > 0 ? `${hidden.join(", ")}이(가) 보고 있었다.` : "아무도 보지 않았다.";
    } else if (check.outcome === "partial") {
      finding = hidden.length > 0 ? "누군가 본 것 같다. 누군지는 모르겠다." : "확신할 수 없다.";
    } else {
      finding = "";
    }
    if (finding) {
      ctx.store.append({
        type: "belief_added",
        characterId: state.playerId,
        belief: {
          id: `b_${ctx.store.getState().nextBeliefNo}`,
          fact: `"${deed.summary}" — ${finding}`,
          source: "seen",
          accuracy: check.outcome === "success" ? "exact" : "approximate",
          learnedAt: state.time,
        },
      });
    }
    const extra: ToolDisplayEvent[] = finding ? [{ type: "belief", fact: finding, sourceLabel: "직접 봄" }] : [];
    return {
      ok: true,
      resultText: `주변 살피기: ${check.display.outcomeLabel}. ${finding || "아무것도 알아내지 못했다 (누가 봤는지 여부도 모른다)."} 이 결과대로 서술하라.`,
      display: check.display,
      extra,
    };
  },
});

const revealSecret = defineTool({
  name: "reveal_secret",
  description:
    "장면에 있는 인물이 플레이어에게 비밀을 털어놓는다. <상태>에 그 인물이 '비밀을 털어놓을 수 있는 관계'라고 표시되고, " +
    "공개 상황이 맞을 때만 쓴다. 비밀의 내용은 시스템이 결과로 알려 준다.",
  schema: z.strictObject({ npc_id: z.string() }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const npc = ctx.content.npcs[input.npc_id];
    if (!npc || !state.scene.present.includes(input.npc_id)) return { ok: false, error: "장면에 없는 인물입니다." };
    if (!npc.secret) return { ok: false, error: `${npc.name}은(는) 털어놓을 비밀이 없다.` };
    if (state.revealedSecrets.includes(npc.id)) return { ok: false, error: "이미 털어놓은 비밀이다." };
    const trust = state.relations[npc.id]?.[state.playerId]?.trust ?? 0;
    if (trust < npc.secret.min_trust) return { ok: false, error: `${npc.name}은(는) 아직 그만큼 당신을 믿지 않는다.` };

    ctx.store.append({ type: "secret_revealed", npcId: npc.id });
    const fact = `${npc.name}의 고백: ${npc.secret.content}`;
    ctx.store.append({
      type: "belief_added",
      characterId: state.playerId,
      belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact, source: "report", accuracy: "exact", learnedAt: state.time },
    });
    return {
      ok: true,
      resultText: `${npc.name}이(가) 털어놓는다: ${npc.secret.content}\n이 인물의 말투와 성격대로, 망설임과 감정을 담아 서술하라.`,
      display: { type: "belief", fact, sourceLabel: "고백" },
    };
  },
});

export const REPUTATION_TOOLS = [recordDeedTool, lookForWitnesses, revealSecret] as const;

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
      .filter((c) => c.id !== state.playerId && !c.dead && ctx.content.npcs[c.id])
      .map((c) => c.id);
    const learned = spreadOneDay({
      deeds: Object.values(state.deeds),
      knowledge: state.deedKnowledge,
      npcIds,
      isTalkative: (id) => ctx.content.npcs[id]?.temperament.includes("talkative") ?? false,
      rng: ctx.rng,
    });
    for (const l of learned) learn(ctx, state.deeds[l.deedId]!, l.npcId, l.source);
  }
  ctx.store.append({ type: "rumors_spread", day });
}
