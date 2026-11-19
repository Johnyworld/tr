import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { disciplineOf } from "../game/culture.ts";
import { templateKind } from "../game/kinds.ts";
import { checkPromotion, commanderOf } from "../game/missions.ts";
import { rankName } from "../game/ranks.ts";
import { roleOf, type GameState } from "../game/state.ts";
import { josa } from "../text.ts";
import { squadMembers } from "./command.ts";
import { createExtraCharacter } from "./extras.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 진급 제안과 분대 (12-190, 플레이 테스트 8).
 * - 진급 조건을 채운 채 임무를 보고하면 상관이 자리를 제안한다 (강제로 올리지 않는다). 거절해도 제안은 열려 있다
 * - 받을 때(promotion accept)는 조건을 다시 본다 (그사이 불복종이 늘거나 상관과 틀어졌으면 상관이 거절한다)
 * - 분대를 맡는 계급(시나리오 promotion.to)이 되면 분대를 꾸린다: 같은 무리에 비어 있는 분대(그 계급 역할의 squad)가 있어도
 *   NEW_SQUAD_CHANCE로 새 사람 1~3명으로 꾸린다 (늘 같은 사람이 분대원이 되지 않게). 빈 분대가 없으면 새 사람으로
 * - 분대가 MAX_SQUAD보다 적은 동안 우리 무리에 피난민이 들면 REFUGEE_TO_SQUAD 확률로 그중 한 명이 분대에 배치된다
 * 새 사람은 그 무리의 엑스트라 틀(분대원 계급의 사람)로 만든다
 */

const NEW_SQUAD_CHANCE = 0.7;
const MAX_SQUAD = 4;
const REFUGEE_TO_SQUAD = 0.5;

/** 이 무리의 분대원이 될 수 있는 틀 (사람, 진급 전 계급) */
function recruitTemplates(content: Content, factionId: string) {
  const from = content.scenario.promotion.from;
  return Object.entries(content.extras).filter(([, t]) => t.faction === factionId && templateKind(t) === "person" && t.rank === from);
}

/** 이 무리의 거점 (새 사람이 있는 곳) */
function baseOf(content: Content, state: GameState, factionId: string): string | null {
  return Object.values(content.locations).find((l) => l.kind === "base" && state.zones[l.id]?.owner === factionId)?.id ?? null;
}

/** 새 사람 하나를 그 무리의 분대원 틀로 만든다 (장면에는 들이지 않는다). id */
function newRecruit(ctx: ToolContext, factionId: string): string | null {
  const { store, content, rng } = ctx;
  const templates = recruitTemplates(content, factionId);
  if (!templates.length) return null;
  const state = store.getState();
  const [, template] = templates[Math.floor(rng() * templates.length)]!;
  const id = `ex_${state.nextExtraNo}`;
  const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
  const character = createExtraCharacter(content, template, { id, label: template.label, zone: baseOf(content, state, factionId), time: state.time, usedNames }, rng);
  store.append({ type: "extra_spawned", character, unseen: true });
  // 분대장에게는 이름과 함께 소개된다
  store.append({ type: "name_learned", characterId: state.playerId, targetId: id });
  return id;
}

/** 같은 무리에 비어 있는 분대: 그 계급의 다른 역할의 분대원 (살아 있고 무리에 있는 사람) */
function vacantSquad(content: Content, state: GameState, factionId: string, rank: string): string[] {
  const mine = roleOf(content, state);
  for (const role of Object.values(content.roles)) {
    if (role.id === mine?.id || role.faction !== factionId || role.rank !== rank || !role.squad?.length) continue;
    const members = role.squad.filter((id) => {
      const c = state.characters[id];
      return id !== state.playerId && !!c && !c.dead && !c.away && !c.captive && c.factionId === factionId && !(mine?.squad_mates ?? []).includes(id);
    });
    if (members.length) return members;
  }
  return [];
}

/** 분대를 맡는 계급이 됐을 때 분대를 꾸린다. GM에게 줄 줄 */
export function formSquad(ctx: ToolContext): string[] {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me?.factionId || me.rank !== content.scenario.promotion.to || squadMembers(state, content).length) return [];
  const vacant = vacantSquad(content, state, me.factionId, me.rank);
  if (vacant.length && rng() >= NEW_SQUAD_CHANCE) {
    store.append({ type: "squad_set", members: vacant });
    return [`비어 있던 분대를 맡았다: ${vacant.map((id) => playerCalls(store.getState(), content, id)).join(", ")}.`];
  }
  const n = 1 + Math.floor(rng() * 3);
  const recruits: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newRecruit(ctx, me.factionId);
    if (id) recruits.push(id);
  }
  if (!recruits.length) {
    if (!vacant.length) return ["아직 맡을 분대가 없다 (분대원이 배치되면 squad_order를 쓸 수 있다)."];
    store.append({ type: "squad_set", members: vacant });
    return [`비어 있던 분대를 맡았다: ${vacant.map((id) => playerCalls(store.getState(), content, id)).join(", ")}.`];
  }
  store.append({ type: "squad_set", members: recruits });
  const after = store.getState();
  return [`새 분대원 ${recruits.length}명이 배치됐다: ${recruits.map((id) => `${after.characters[id]!.name} (${id}, ${after.characters[id]!.extra?.look ?? ""})`).join(" / ")}. 처음 인사하는 장면으로 서술할 수 있다.`];
}

/** 우리 무리에 피난민이 들었을 때 (이야기 효과 faction_population): 분대가 모자라면 확률로 한 명이 분대에 배치된다 */
export function refugeeToSquad(ctx: ToolContext): string | null {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me?.factionId || me.rank !== content.scenario.promotion.to || !state.squad) return null;
  if (squadMembers(state, content).length >= MAX_SQUAD || rng() >= REFUGEE_TO_SQUAD) return null;
  const id = newRecruit(ctx, me.factionId);
  if (!id) return null;
  store.append({ type: "squad_joined", characterId: id });
  const c = store.getState().characters[id]!;
  return `새로 받아들인 사람 가운데 ${josa(c.name, "이/가")} 당신의 분대에 배치됐다 (${id}, ${c.extra?.look ?? ""}).`;
}

/** 진급 조건을 채운 채 임무를 보고했을 때: 상관이 자리를 제안한다 (이미 제안했으면 다시 하지 않는다). GM에게 줄 줄 */
export function offerPromotion(ctx: ToolContext, commanderTrust: number | null): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const promotion = content.scenario.promotion;
  if (state.promotionOffer || me.rank !== promotion.from) return null;
  if (!checkPromotion(me, promotion, state.time, state.runStartedAt, commanderTrust, disciplineOf(content, me.factionId).maxDisobedience).eligible) return null;
  store.append({ type: "promotion_offered", to: promotion.to });
  const to = rankName(content, me.factionId, promotion.to);
  return `진급 제안: 상관이 ${josa(to, "을/를")} 맡으라고 한다. 강제가 아니다. 플레이어가 답하면 promotion accept 또는 decline (거절해도 나중에 상관에게 맡겠다고 하면 다시 받을 수 있다).`;
}

const promotionTool = defineTool({
  name: "promotion",
  description:
    "상관이 내놓은 진급 제안(GM 상태의 '진급 제안')에 플레이어가 답한다. 상관이 장면에 있어야 한다. accept: 맡는다 (조건을 다시 본다. 그사이 불복종이 늘거나 상관의 신뢰가 떨어졌으면 거절당한다). " +
    "decline: 지금은 사양한다 (제안은 열려 있어, 나중에 플레이어가 맡겠다고 하면 accept). 분대는 시스템이 꾸린다.",
  schema: z.strictObject({ action: z.enum(["accept", "decline"]) }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    const offer = state.promotionOffer;
    const promotion = content.scenario.promotion;
    if (!offer || me.rank !== promotion.from) return { ok: false, error: "받을 수 있는 진급 제안이 없다. 진급 조건을 채운 채 임무를 보고하면 상관이 제안한다." };
    const commander = commanderOf(state, content);
    if (!commander || !state.scene.present.includes(commander)) return { ok: false, error: "상관이 장면에 있어야 한다 (npc_presence)." };
    const boss = playerCalls(state, content, commander);
    const quiet: ToolDisplayEvent = { type: "time", activityLabel: "진급", durationLabel: "", fromLabel: "", toLabel: "" };
    if (input.action === "decline") {
      store.append({ type: "promotion_declined" });
      return { ok: true, resultText: `${josa(boss, "은/는")} 제안을 거두지 않는다. 마음이 바뀌면 말하라고 한다. 이 결과대로 서술하라.`, display: quiet };
    }
    const trust = state.relations[commander]?.[me.id]?.trust ?? 0;
    const check = checkPromotion(me, promotion, state.time, state.runStartedAt, trust, disciplineOf(content, me.factionId).maxDisobedience);
    if (!check.eligible) {
      return { ok: true, resultText: `${josa(boss, "이/가")} 고개를 젓는다: 지금은 맡길 수 없다 (${check.missing.join(", ")}). 이 결과대로 서술하라.`, display: quiet };
    }
    store.append({ type: "promoted", characterId: me.id, from: promotion.from, to: promotion.to });
    const fromLabel = rankName(content, me.factionId, promotion.from);
    const toLabel = rankName(content, me.factionId, promotion.to);
    const lines = [`진급: ${josa(me.name, "이/가")} ${fromLabel}에서 ${josa(toLabel, "으로/로")} 진급했다. ${josa(boss, "이/가")} 이를 알리는 장면을 서술하라.`, ...formSquad(ctx)];
    return { ok: true, resultText: lines.join("\n"), display: { type: "promotion", name: me.name, fromLabel, toLabel } };
  },
});

export const PROMOTION_TOOLS = [promotionTool] as const;

/** GM 상태의 줄: 열려 있는 진급 제안 */
export function describePromotionOffer(content: Content, state: GameState): string | null {
  const offer = state.promotionOffer;
  const me = state.characters[state.playerId];
  if (!offer || !me || me.rank !== content.scenario.promotion.from) return null;
  const to = rankName(content, me.factionId, offer.to);
  return offer.declined
    ? `진급 제안: 한 번 사양했다. 플레이어가 ${josa(to, "을/를")} 맡겠다고 하면 상관이 장면에 있을 때 promotion accept (조건을 다시 본다).`
    : `진급 제안: 상관이 ${josa(to, "을/를")} 맡으라고 했다. 플레이어가 답하면 promotion accept 또는 decline.`;
}
