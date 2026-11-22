import { heldOf } from "../rules/held.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import { AI_TRUCE_DISPOSITION, disposition, HOSTILE } from "../sim/war.ts";
import { josa } from "../text.ts";
import { rollPlayerCheck } from "./checks.ts";
import { sitsOnCouncil } from "./command.ts";
import { troublesOf } from "./factionTalk.ts";
import { recordDeed } from "./reputationTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 외교 (기획서 9.14, 12-126): 지도부 회의에 앉는 주인공이 다른 무리의 간부와 협정을 맺는다.
 * - 휴전(truce): 정한 날수 동안 두 무리의 태도를 적대 기준 바로 위로 올려 둔다. 그래서 전쟁 틱·곁의 사람·손님 난방이 그대로 따라온다. 끝나면 원래 태도로
 * - 포로 교환(exchange): 서로 잡고 있는 상대 무리 사람을 돌려보낸다
 * 받아들여지는지는 판정과 상황(상대의 태도, 형편, 힘 차이, 협상 상대의 신뢰)으로 코드가 정한다 (원칙 2). AI 무리끼리의 협정은 아직 없다
 */

const DIFFICULTY = ["very_hard", "hard", "normal", "easy", "very_easy"] as const;
/** 휴전 동안의 태도: 적대 기준 바로 위 */
const TRUCE_DISPOSITION = HOSTILE + 1;

const rulesOf = (content: Content) => content.scenario.diplomacy;
const factionName = (content: Content, id: string) => content.factions[id]?.name ?? id;
const rankLevelOf = (content: Content, rank: string) => content.scenario.rank_ladder.find((r) => r.id === rank)?.level ?? 0;

/** 두 무리 사이의 진행 중인 휴전 */
export function truceBetween(state: Pick<GameState, "pacts">, a: string, b: string) {
  return state.pacts.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a)) ?? null;
}

/** 협상의 상황 보정: 상대의 태도, 상대의 형편, 힘 차이, 협상 상대의 신뢰. 합쳐 -2 ~ +2 */
export function negotiationFactors(state: GameState, content: Content, mine: string, theirs: string, envoy: string): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  const regard = disposition(content, theirs, mine, state);
  if (regard >= 0) out.push({ label: "우리를 나쁘게 보지 않는다", value: 1 });
  else if (regard <= -3) out.push({ label: "우리를 깊이 미워한다", value: -1 });
  if (troublesOf(state, content, theirs).some((t) => t.kind === "morale" || t.kind === "ration")) out.push({ label: "그쪽 형편이 어렵다", value: 1 });
  const ours = state.factions[mine]?.combatants ?? 0;
  const theirsN = state.factions[theirs]?.combatants ?? 0;
  if (theirsN > 0 && ours / theirsN >= 1.5) out.push({ label: "우리가 더 세다", value: 1 });
  else if (ours > 0 && ours / Math.max(1, theirsN) <= 0.67) out.push({ label: "그쪽이 더 세다", value: -1 });
  const trust = (state.relations[envoy]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
  if (trust >= 4) out.push({ label: "협상 상대가 당신을 믿는다", value: 1 });
  else if (trust <= -4) out.push({ label: "협상 상대가 당신을 믿지 않는다", value: -1 });
  return out;
}

const negotiate = defineTool({
  name: "negotiate",
  description:
    "간부: 다른 무리의 간부 이상과 한 장면에서 협정을 제안한다 (기획서 9.14). 휴전(정한 날수 동안 서로 치지 않는다), 포로 교환(서로 잡은 사람을 돌려보낸다). " +
    "받아들여지는지와 대가는 코드가 정한다 (상대의 태도·형편·힘 차이·협상 상대의 신뢰가 판정 난이도가 된다). 거절당하면 며칠 다시 꺼내지 못하고 상대의 태도가 나빠진다. " +
    "pact는 GM 상태 '외교'의 협정 id, envoy는 장면에 있는 상대 무리 간부의 id, approach는 협상에 쓰는 스킬.",
  schema: z.strictObject({
    pact: z.string().min(1),
    envoy: z.string().min(1).describe("장면에 있는 상대 무리 간부 이상의 인물 id"),
    approach: z.string().min(1).describe("협상에 쓰는 스킬 id (교섭·위협·거짓말 등)"),
    stat: z.string().min(1).describe("그 스킬에 쓰는 능력 id"),
    intent: z.string().min(1).max(200).describe("무엇을 내세워 제안하는지 한 줄"),
  }),
  run(input, ctx) {
    const { store, content } = ctx;
    const rules = rulesOf(content);
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    if (!rules) return { ok: false, error: "이 월드에는 외교 규칙이 없다." };
    if (!sitsOnCouncil(state, content)) return { ok: false, error: "무리를 대표해 협상할 계급이 아니다 (지도부 회의에 앉는 간부만)." };
    const pact = rules.pacts.find((p) => p.id === input.pact);
    if (!pact) return { ok: false, error: `없는 협정: ${input.pact} (가능: ${rules.pacts.map((p) => p.id).join(", ")})` };
    const envoy = state.characters[input.envoy];
    if (!envoy || envoy.dead || !state.scene.present.includes(envoy.id)) return { ok: false, error: "그 인물이 장면에 없다. 먼저 npc_presence로 들인다." };
    const theirs = envoy.factionId;
    if (!theirs || theirs === me.factionId || !state.factions[theirs]) return { ok: false, error: "다른 무리의 사람과만 협상한다." };
    if (rankLevelOf(content, envoy.rank) < rules.envoy_level) return { ok: false, error: `${playerCalls(state, content, envoy.id)}에게는 무리를 대신해 약속할 권한이 없다 (간부 이상과 협상한다).` };
    if (!rules.moves.includes(input.approach)) return { ok: false, error: `협상에 쓰는 스킬이 아니다 (가능: ${rules.moves.join(", ")})` };
    const blocked = state.negotiationBlocked[theirs] ?? 0;
    if (state.time < blocked) return { ok: false, error: `${josa(factionName(content, theirs), "은/는")} 얼마 전 제안을 거절했다. ${formatTime(blocked)} 뒤에 다시 꺼낼 수 있다.` };
    const mine = me.factionId;
    if (pact.kind === "truce" && truceBetween(state, mine, theirs)) return { ok: false, error: "이미 휴전 중이다." };
    if (pact.kind === "truce" && disposition(content, theirs, mine, state) > HOSTILE && disposition(content, mine, theirs, state) > HOSTILE) {
      return { ok: false, error: "서로 싸우는 사이가 아니다. 휴전할 일이 없다." };
    }
    const ourPeople = Object.values(state.characters).filter((c) => !c.dead && heldOf(c)?.by === theirs && c.factionId === mine);
    const theirPeople = Object.values(state.characters).filter((c) => !c.dead && heldOf(c)?.by === mine && c.factionId === theirs);
    if (pact.kind === "exchange" && ourPeople.length === 0) return { ok: false, error: `${factionName(content, theirs)}에 붙잡힌 우리 사람이 없다.` };

    const factors = negotiationFactors(state, content, mine, theirs, envoy.id);
    const sum = Math.max(-2, Math.min(2, factors.reduce((n, f) => n + f.value, 0)));
    const check = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty: DIFFICULTY[sum + 2]!, intent: input.intent }, ctx);
    if (!check.ok) return check;
    const outcome = check.outcome;
    const envoyName = playerCalls(state, content, envoy.id);
    let agreed = "";
    const lines = [`판정: ${CHECK_OUTCOME_LABELS[outcome]} (상황: ${factors.map((f) => `${f.label} ${f.value > 0 ? "+" : ""}${f.value}`).join(", ") || "특별한 것 없음"})`];

    if (outcome === "miss") {
      const until = state.time + rules.retry_days * MINUTES_PER_DAY;
      store.append({ type: "negotiation_refused", factionId: theirs, until });
      const now = disposition(content, theirs, mine, state);
      if (now > -3) store.append({ type: "faction_disposition_changed", from: theirs, to: mine, value: now - 1 });
      lines.push(`${josa(envoyName, "이/가")} ${pact.label} 제안을 거절했다. ${josa(factionName(content, theirs), "은/는")} 우리를 전보다 나쁘게 본다. ${rules.retry_days}일 동안 다시 꺼내지 못한다.`);
    } else {
      const id = `pact_${state.turn}_${theirs}`;
      if (pact.kind === "truce") {
        const restore = { ab: disposition(content, mine, theirs, state), ba: disposition(content, theirs, mine, state) };
        const until = state.time + (pact.days ?? 7) * MINUTES_PER_DAY;
        store.append({ type: "pact_made", id, kind: "truce", a: mine, b: theirs, until, restore });
        store.append({ type: "faction_disposition_changed", from: mine, to: theirs, value: Math.max(restore.ab, TRUCE_DISPOSITION) });
        store.append({ type: "faction_disposition_changed", from: theirs, to: mine, value: Math.max(restore.ba, TRUCE_DISPOSITION) });
        agreed = `${josa(factionName(content, theirs), "과/와")} 휴전했다. ${formatTime(until)}까지 서로 치지 않는다`;
        lines.push(`${agreed}. 휴전 중에 그쪽 사람을 치면 휴전이 깨지고 배신으로 남는다.`);
      } else {
        store.append({ type: "pact_made", id, kind: "exchange", a: mine, b: theirs });
        for (const c of [...ourPeople, ...theirPeople]) store.append({ type: "npc_released", npcId: c.id });
        const back = ourPeople.map((c) => playerCalls(store.getState(), content, c.id)).join(", ");
        agreed = `${josa(factionName(content, theirs), "과/와")} 포로를 바꿨다. 우리 사람(${back})이 풀려나 돌아온다`;
        lines.push(`${agreed}${theirPeople.length ? `. 우리가 잡고 있던 ${factionName(content, theirs)} 사람 ${theirPeople.length}명도 돌려보낸다` : ""}.`);
      }
      if (outcome === "partial") {
        const paid: string[] = [];
        for (const [resource, amount] of Object.entries(pact.cost)) {
          const have = state.factions[mine]?.resources[resource] ?? 0;
          const give = Math.min(have, amount);
          if (give <= 0) continue;
          store.append({ type: "faction_resource_changed", factionId: mine, resource, delta: -give });
          store.append({ type: "faction_resource_changed", factionId: theirs, resource, delta: give });
          paid.push(content.scenario.resources.find((r) => r.id === resource)?.label ?? resource);
        }
        if (paid.length) lines.push(`대가로 우리 창고의 ${josa(paid.join("·"), "을/를")} 내주기로 했다.`);
      }
      // 협정은 우리 무리 사람이면 누구나 곧 안다
      const s = store.getState();
      store.append({ type: "belief_added", characterId: s.playerId, belief: { id: `b_${s.nextBeliefNo}`, fact: agreed, source: "seen", accuracy: "exact", learnedAt: s.time } });
    }
    lines.push("협상 장면을 이 결과대로 서술한다. 숫자(날짜·창고 양)는 지어내지 않는다.");
    return { ok: true, resultText: lines.join("\n"), display: check.display };
  },
});

export const DIPLOMACY_TOOLS = [negotiate] as const;

/** 기한이 된 휴전을 끝내고 원래 태도로 돌린다 (하루 틱). 우리 무리의 휴전이면 주인공이 듣는다 */
export function endExpiredTruces(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const displays: ToolDisplayEvent[] = [];
  for (const p of store.getState().pacts) {
    const state = store.getState();
    if (p.until > state.time) continue;
    store.append({ type: "pact_ended", id: p.id, broken: false });
    // 휴전 동안 다른 일로 태도가 바뀌지 않았으면 원래대로
    if (disposition(content, p.a, p.b, state) === Math.max(p.restore.ab, TRUCE_DISPOSITION)) store.append({ type: "faction_disposition_changed", from: p.a, to: p.b, value: p.restore.ab });
    if (disposition(content, p.b, p.a, state) === Math.max(p.restore.ba, TRUCE_DISPOSITION)) store.append({ type: "faction_disposition_changed", from: p.b, to: p.a, value: p.restore.ba });
    const me = state.characters[state.playerId];
    if (me && (p.a === me.factionId || p.b === me.factionId)) {
      const other = p.a === me.factionId ? p.b : p.a;
      const fact = `${josa(factionName(content, other), "과/와")}의 휴전이 끝났다`;
      const s = store.getState();
      store.append({ type: "belief_added", characterId: s.playerId, belief: { id: `b_${s.nextBeliefNo}`, fact, source: "report", accuracy: "exact", learnedAt: s.time } });
      displays.push({ type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS.report });
    }
  }
  return displays;
}

/**
 * 주인공이 휴전 중인 무리의 사람을 쳤다: 휴전이 깨지고 두 무리가 서로를 깊이 미워하게 되며, 배신이 행적으로 남는다.
 * 깨졌으면 GM에게 알릴 한 줄 (아니면 null)
 */
export function breakTruceIfAny(ctx: ToolContext, targetId: string): string | null {
  const { store, content } = ctx;
  const rules = rulesOf(content);
  const state = store.getState();
  const me = state.characters[state.playerId];
  const target = state.characters[targetId];
  if (!rules || !me?.factionId || !target?.factionId) return null;
  const truce = truceBetween(state, me.factionId, target.factionId);
  if (!truce) return breakAiTruceIfAny(ctx, me.factionId, target.factionId, rules.broken);
  store.append({ type: "pact_ended", id: truce.id, broken: true });
  store.append({ type: "faction_disposition_changed", from: truce.a, to: truce.b, value: rules.broken });
  store.append({ type: "faction_disposition_changed", from: truce.b, to: truce.a, value: rules.broken });
  const other = factionName(content, target.factionId);
  recordDeed(ctx, { summary: `휴전 중에 ${other} 사람을 쳤다`, tags: ["betrayal"], severity: 2, privacy: "public", noisy: false });
  return `휴전이 깨졌다. ${josa(other, "은/는")} 이제 우리 무리를 깊이 미워한다. 배신으로 기억될 것이다.`;
}

/**
 * 지도부끼리 맺은 휴전(12-146)도 주인공이 그쪽 사람을 치면 깨진다 (12-147). 태도가 아직 휴전 값일 때만
 * (이미 다른 일로 틀어졌으면 깰 휴전이 없다). 남은 기록은 기한이 되면 저절로 지워진다
 */
function breakAiTruceIfAny(ctx: ToolContext, mine: string, theirs: string, broken: number): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  if (!aiTruceActive(state, content, mine, theirs)) return null;
  store.append({ type: "faction_disposition_changed", from: mine, to: theirs, value: broken });
  store.append({ type: "faction_disposition_changed", from: theirs, to: mine, value: broken });
  const other = factionName(content, theirs);
  recordDeed(ctx, { summary: `지도부가 맺은 휴전 중에 ${other} 사람을 쳤다`, tags: ["betrayal"], severity: 2, privacy: "public", noisy: false });
  return `휴전이 깨졌다. 지도부가 얻어 낸 휴전이었다. ${josa(other, "은/는")} 이제 우리 무리를 깊이 미워하고, 우리 무리 안에서도 말이 나올 것이다.`;
}

/** 두 무리 사이에 지도부끼리 맺은 휴전이 살아 있는가 (기록이 있고 태도가 아직 휴전 값) */
function aiTruceActive(state: GameState, content: Content, mine: string, theirs: string): boolean {
  const t = state.factions[mine]?.truces?.[theirs];
  return !!t && t.days > 0 && disposition(content, mine, theirs, state) === AI_TRUCE_DISPOSITION && disposition(content, theirs, mine, state) === AI_TRUCE_DISPOSITION;
}

/** GM 상태의 외교 줄: 우리 무리의 휴전, 협상할 수 있는 협정 (간부일 때) */
export function describeDiplomacyForGm(state: GameState, content: Content): string {
  const rules = rulesOf(content);
  const me = state.characters[state.playerId];
  if (!rules || !me?.factionId) return "";
  const lines: string[] = [];
  for (const p of state.pacts) {
    if (p.a !== me.factionId && p.b !== me.factionId) continue;
    lines.push(`- ${josa(factionName(content, p.a === me.factionId ? p.b : p.a), "과/와")} 휴전 중 (${formatTime(p.until)}까지). 그쪽 사람을 치면 휴전이 깨진다`);
  }
  // 지도부끼리 맺은 휴전 (12-146): 크게 밀린 무리가 얻어 낸 숨 돌릴 틈
  for (const [other, t] of Object.entries(state.factions[me.factionId]?.truces ?? {})) {
    if (!aiTruceActive(state, content, me.factionId, other)) continue;
    lines.push(`- ${josa(factionName(content, other), "과/와")} 지도부끼리 맺은 휴전 중 (약 ${t.days}일 남음). 그동안 무리끼리는 서로 치지 않는다. 그쪽 사람을 치면 휴전이 깨진다`);
  }
  if (sitsOnCouncil(state, content)) {
    lines.push(`협상할 수 있는 협정 (negotiate, 다른 무리의 간부 이상이 장면에 있을 때): ${rules.pacts.map((p) => `${p.id} ${p.label}(${p.summary})`).join(", ")}. 스킬: ${rules.moves.join(", ")}`);
  }
  return lines.length ? `외교:\n${lines.join("\n")}` : "";
}
