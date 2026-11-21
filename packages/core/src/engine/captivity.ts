import { onCaptured } from "../rules/consequence.ts";
import { heldOf } from "../rules/held.ts";
import { z } from "zod";
import { isCreature } from "../game/kinds.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Clash, GameState } from "../game/state.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { harmTrack, incapacitatingSymptom, learnedSkill, moveOf } from "../scenario/scenario.ts";
import type { Character } from "../game/character.ts";
import { disposition } from "../sim/war.ts";
import { josa, sentence } from "../text.ts";
import type { Content } from "../content/schemas.ts";
import { endBattle } from "./battleTools.ts";
import { rollPlayerCheck } from "./checks.ts";
import { recordDeed } from "./reputationTools.ts";
import { TROUBLE_TOPIC, troublesOf } from "./factionTalk.ts";
import { activeMissionOf } from "../game/missions.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";
import { ownedBy } from "../rules/home.ts";

/**
 * 포로 (기획서 7.6, 12-55).
 * - 주인공도 붙잡힌다: 진 전투에서 물러나지 않았으면 빠져나가기 판정에 실패해서(12-220), 항복하면 반드시, 이야기 효과로. 죽음 대신 갇힌다 (원칙 3: 코드가 정한다)
 *   갇힌 동안: 무기·탄은 빼앗기고(풀려나면 돌려받는다), 갇힌 구역에 묶이고, 갇힌 동안의 이야기(captivity.tag)만 열린다. 탈출은 무거운 위험을 건 판정
 * - 주인공이 포로를 잡는다: 크게 다친 사람을 묶어 끌고 가고(동행 prisoner), 우리 거점에 닿으면 우리 무리의 포로가 된다
 * - 포로를 다룬다: 심문(그 사람이 아는 것에서 코드가 고른다), 회유, 석방, 몸값·맞교환, 노역. 포로는 붙잡은 무리의 먹을 것을 먹는다
 * - 무리 사이 싸움에서 이긴 쪽이 이름 있는 사람을 붙잡아 가기도 한다
 */

const rules = (content: Content) => content.scenario.captivity;
export const baseOf = (content: Content, faction: string) => Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")?.id;

/** 주인공이 붙잡힌다. 갇히는 곳은 zone이 없으면 붙잡은 무리의 거점. 돌려줄 한 줄 */
export function capturePlayer(ctx: ToolContext, by: string, zone?: string, cause = "붙잡혔다"): string | null {
  const { store, content } = ctx;
  const c = rules(content);
  const state = store.getState();
  const me = state.characters[state.playerId];
  const where = zone ?? baseOf(content, by);
  if (!c || !me || me.dead || heldOf(me) || !where || !content.factions[by] || by === me.factionId) return null;
  // 동행은 그 자리에 남는다 (끌고 가던 포로는 풀려난다). 임무 짝은 자기 자리로 돌아가 알린다 (플레이 테스트 13: 적 거점에서 이틀을 기다리다 다시 합류했다)
  const left = state.companions.length > 0;
  for (const id of state.companions) {
    const kind = state.bonds[id]?.kind;
    if (kind === "prisoner" || kind === "buddy") store.append({ type: "companion_left", characterId: id, reason: kind === "buddy" ? "짝이 붙잡혀 혼자 돌아갔다" : "풀려났다" });
    else if (state.playerZone) store.append({ type: "companion_parted", characterId: id, zone: state.playerZone, until: null });
  }
  const held = Object.fromEntries(Object.entries(me.inventory).filter(([id, n]) => n > 0 && (c.confiscate.includes(content.items[id]?.kind ?? "") || c.confiscate_items.includes(id))));
  // 붙잡힌 결과는 공통 규칙 3 (rules/consequence.ts): 들키지 않기 임무, 침입 행적, 그 무리의 태도
  const spotted = onCaptured(ctx, by).join(" ");
  store.append({ type: "player_captured", by, zone: where, held });
  const name = content.factions[by]!.name;
  const fact = sentence(`${cause}. ${name}에 붙잡혀 ${content.locations[where]?.name ?? where}에 갇혔다`);
  store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${store.getState().nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
  return (
    `${fact} 무기와 탄은 빼앗겼다.${left ? " 함께 있던 사람은 따라오지 못했다." : ""} ${spotted ? `${spotted} ` : ""}` +
    `갇힌 동안에는 갇힌 곳의 이야기만 열린다. 빠져나가려면 맞닿은 구역으로 옮겨 가는 행동에 ${c.escape_moves.join("/")} 판정과 무거운 위험(heavy)을 건다.`
  );
}

/** 주인공이 풀려난다 (빼앗긴 것을 돌려받는지는 어떻게 풀려나는지에 따라) */
export function releasePlayer(ctx: ToolContext, returned: boolean): string | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const held = heldOf(me);
  if (!held) return null;
  // 빼앗긴 것을 적는다 (플레이 테스트 13: "그곳에 두고 왔다" 한 줄이라 무엇을 잃었는지 몰랐다)
  const taken = Object.entries(state.deposits[`held:${held.by}`] ?? {}).filter(([, n]) => n > 0).map(([id, n]) => `${ctx.content.items[id]?.name ?? id} ×${n}`);
  ctx.store.append({ type: "player_released", returned });
  if (returned) return `풀려났다. 빼앗겼던 것을 돌려받았다${taken.length ? ` (${taken.join(", ")})` : ""}.`;
  return `빠져나왔다. 빼앗긴 것은 그곳에 두고 왔다${taken.length ? `: ${taken.join(", ")}` : ""}.${taken.length ? " 맨손이면 우리 거점의 무기고가 근접 무기 하나를 내준다." : ""}`;
}

/** 빠져나가기에 가장 나은 판정: flee_moves 중 능력 + 스킬이 가장 높은 것 (배우지 않은 전문 기술은 빼고) */
function bestFlee(content: Content, me: Character, moves: string[]): { move: string; stat: string } | null {
  let best: { move: string; stat: string; value: number } | null = null;
  for (const id of moves) {
    const m = moveOf(content.scenario, id);
    const skill = learnedSkill(content.scenario, me.skills, id);
    if (!m || skill === null) continue;
    for (const stat of m.stats) {
      const value = (me.stats[stat] ?? 0) + skill;
      if (!best || value > best.value) best = { move: id, stat, value };
    }
  }
  return best;
}

/**
 * 진 전투 뒤 (12-220): 물러나지 않았고 살아 있으면 빠져나가기를 굴린다 (flee_moves 중 가장 나은 것). 정신을 잃었으면 굴리지 않고 붙잡힌다.
 * 성공 = 빠져나간다, 대가 있는 성공 = 빼앗길 물건(무기·탄)을 버리고 빠져나간다, 실패 = 붙잡힌다. 부상은 몸 상태 보정으로 판정에 든다
 */
export function maybeCaptureAfterDefeat(ctx: ToolContext, enemy: string): { lines: string[]; displays: ToolDisplayEvent[] } {
  const c = rules(ctx.content);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const none = { lines: [], displays: [] };
  if (!c || !me || me.dead || heldOf(me)) return none;
  const down = !!incapacitatingSymptom(ctx.content.scenario, me);
  const flee = down ? null : bestFlee(ctx.content, me, c.flee_moves);
  if (!flee) {
    const caught = capturePlayer(ctx, enemy, undefined, "싸움에 지고 쓰러진 채로 끌려갔다");
    return { lines: caught ? [caught] : [], displays: [] };
  }
  const roll = rollPlayerCheck({ move: flee.move, stat: flee.stat, difficulty: "normal", intent: "진 싸움터에서 빠져나간다" }, ctx);
  if (!roll.ok) return none;
  const displays: ToolDisplayEvent[] = [roll.display];
  if (roll.outcome === "miss") {
    const caught = capturePlayer(ctx, enemy, undefined, "싸움에 지고 빠져나가지 못해 붙잡혔다");
    return { lines: caught ? [caught] : [], displays };
  }
  if (roll.outcome === "success") return { lines: ["진 싸움터에서 붙잡히지 않고 빠져나왔다. 빠져나오는 장면을 서술한다."], displays };
  // 대가 있는 성공: 무거운 것을 버리고 달아난다
  const dropped = Object.entries(me.inventory).filter(([id, n]) => n > 0 && c.confiscate.includes(ctx.content.items[id]?.kind ?? ""));
  for (const [itemId, quantity] of dropped) ctx.store.append({ type: "item_consumed", holder: me.id, itemId, quantity });
  const names = dropped.map(([id, n]) => `${ctx.content.items[id]?.name ?? id} ×${n}`);
  return {
    lines: [names.length ? `빠져나오긴 했지만 ${josa(names.join(", "), "을/를")} 버리고 왔다 (소지품에서 빠졌다). 버리고 달아나는 장면을 서술한다.` : "간신히 빠져나왔다. 쫓기며 달아나는 장면을 서술한다."],
    displays,
  };
}

/** 포로를 하루 먹이고 부린다: 붙잡은 무리의 먹을 것이 줄고, 노역이면 자원이 는다 */
export function runCaptivity(ctx: ToolContext): void {
  const c = rules(ctx.content);
  if (!c) return;
  const state = ctx.store.getState();
  const cost: Record<string, number> = {};
  const gain: Record<string, number> = {};
  for (const ch of Object.values(state.characters)) {
    if (!heldOf(ch) || ch.dead) continue;
    cost[heldOf(ch)!.by] = (cost[heldOf(ch)!.by] ?? 0) + c.upkeep.amount;
    if (heldOf(ch)!.labor) gain[heldOf(ch)!.by] = (gain[heldOf(ch)!.by] ?? 0) + c.labor.amount;
  }
  for (const [f, n] of Object.entries(cost)) {
    const amount = Math.round(n);
    if (amount > 0 && state.factions[f]) ctx.store.append({ type: "faction_resource_changed", factionId: f, resource: c.upkeep.resource, delta: -amount });
  }
  for (const [f, n] of Object.entries(gain)) if (n > 0 && state.factions[f]) ctx.store.append({ type: "faction_resource_changed", factionId: f, resource: c.labor.resource, delta: n });
}

/**
 * 무리 사이 싸움의 포로: 이긴 쪽이 진 쪽의 이름 있는 싸움꾼 하나를 확률로 붙잡아 간다.
 * 우리 무리 사람이 붙잡혀 가면 주인공은 소식으로 안다 (어디 갇혔는지는 모른다)
 */
export function warCaptures(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  const c = rules(ctx.content);
  if (!c || c.war_capture_chance <= 0) return [];
  const displays: ToolDisplayEvent[] = [];
  for (const clash of clashes) {
    if (clash.kind === "occupy" || !clash.defender) continue;
    const [winner, loser] = clash.success ? [clash.attacker, clash.defender] : [clash.defender, clash.attacker];
    const lost = clash.success ? clash.defenderLosses : clash.attackerLosses;
    if (lost <= 0 || ctx.rng() >= c.war_capture_chance) continue;
    const state = ctx.store.getState();
    const pool = Object.values(state.characters)
      .filter((ch) => ch.factionId === loser && ch.id !== state.playerId && !ch.dead && !ch.away && !heldOf(ch) && ctx.content.npcs[ch.id])
      .filter((ch) => ["grunt", "squad_leader"].includes(ch.rank) && !state.companions.includes(ch.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const taken = pool[Math.floor(ctx.rng() * pool.length)];
    const zone = baseOf(ctx.content, winner);
    if (!taken || !zone) continue;
    ctx.store.append({ type: "npc_captured", npcId: taken.id, by: winner, zone });
    const me = state.characters[state.playerId];
    if (me && !me.dead && me.factionId === loser && (state.known[state.playerId] ?? []).includes(taken.id)) {
      const fact = sentence(`${josa(playerCalls(state, ctx.content, taken.id), "이/가")} ${josa(ctx.content.factions[winner]?.name ?? winner, "과/와")}의 싸움에서 붙잡혀 갔다고 한다`);
      ctx.store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${ctx.store.getState().nextBeliefNo}`, fact, source: "report", accuracy: "approximate", learnedAt: state.time, topic: "war" } });
      displays.push({ type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS.report });
    }
  }
  return displays;
}

/** 갇힌 주인공의 탈출 시도인지, 그리고 그 판정이 맞는지 (action의 이동). 오류면 문장 */
export function escapeRule(state: GameState, content: Content, check: { move: string; harm_on_failure: string } | null): string | null {
  const c = rules(content);
  const me = state.characters[state.playerId];
  if (!c || !heldOf(me)) return null;
  if (!check || !c.escape_moves.includes(check.move) || check.harm_on_failure !== "heavy") {
    return `갇혀 있다 (${content.factions[heldOf(me)!.by]?.name ?? heldOf(me)!.by}). 빠져나가려면 check.move를 ${c.escape_moves.join("/")} 중 하나로, harm_on_failure를 heavy로 위험을 먼저 선언한다 (실패하면 다치고 그대로 갇혀 있다). 아니면 이야기로 풀려나는 길을 찾는다.`;
  }
  return null;
}

/** GM 상태: 주인공이 갇혀 있으면, 그리고 우리 땅에 있으면 여기 갇힌 우리 포로 */
export function describeCaptivityForGm(state: GameState, content: Content): string {
  const me = state.characters[state.playerId];
  if (!me) return "";
  const lines: string[] = [];
  if (heldOf(me)) {
    const c = rules(content);
    lines.push(
      `주인공은 갇혀 있다: ${content.factions[heldOf(me)!.by]?.name ?? heldOf(me)!.by}의 ${content.locations[heldOf(me)!.zone]?.name ?? heldOf(me)!.zone}. ` +
        `무기와 탄은 빼앗겼다. 갇힌 동안의 이야기만 열린다. 탈출은 이동에 ${c?.escape_moves.join("/") ?? "?"} 판정 + 무거운 위험`,
    );
  }
  const here = Object.values(state.characters).filter((ch) => heldOf(ch) && heldOf(ch)!.by === me.factionId && heldOf(ch)!.zone === state.playerZone && !ch.dead && ch.id !== me.id);
  if (here.length && me.factionId) {
    lines.push(
      `우리 무리가 여기 가둔 포로 (handle_prisoner로 다룬다): ${here
        .map((ch) => `${playerCalls(state, content, ch.id)} (${ch.id}, ${content.factions[ch.factionId]?.name ?? "무리 없음"}${heldOf(ch)!.labor ? ", 노역 중" : ""})`)
        .join(", ")}`,
    );
  }
  const towed = state.companions.filter((id) => state.bonds[id]?.kind === "prisoner" && !state.characters[id]?.dead);
  if (towed.length) {
    lines.push(
      `끌고 다니는 포로 (handle_prisoner의 interrogate·release는 여기서도 된다. 나머지는 우리 거점에 데려가야): ${towed
        .map((id) => `${playerCalls(state, content, id)} (${id}, ${content.factions[state.characters[id]!.factionId]?.name ?? "무리 없음"})`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * 포로가 털어놓는 것 (원칙 2·4: 코드가 고른다). 그 사람의 믿음 중 주인공이 모르는 것, 전황이 먼저.
 * 털어놓을 믿음이 없으면 자기 무리의 형편을 말한다 (12-178: 엑스트라 포로도 빈손이 아니다). 진짜 형편에서 나오지만 포로의 입이라 정확도는 대략
 */
function confessions(state: GameState, content: Content, meId: string, t: { id: string; factionId: string }, count: number, exact: boolean) {
  const known = new Set((state.beliefs[meId] ?? []).map((b) => b.fact));
  const facts = (state.beliefs[t.id] ?? [])
    .filter((b) => !known.has(b.fact))
    .sort((a, b) => (b.topic === "war" ? 1 : 0) - (a.topic === "war" ? 1 : 0))
    .slice(0, count)
    .map((b) => ({ fact: b.fact, accuracy: exact ? b.accuracy : ("approximate" as const), topic: b.topic }));
  const faction = content.factions[t.factionId];
  if (facts.length === 0 && faction && state.factions[t.factionId]) {
    const troubles = troublesOf(state, content, t.factionId);
    const fact = troubles.length
      ? `포로의 말로는 ${faction.name} 쪽 사정이 이렇다: ${troubles.map((x) => x.text).join(", ")}`
      : `포로의 말로는 ${faction.name} 쪽은 아직 버틸 만하다`;
    if (!known.has(fact)) facts.push({ fact, accuracy: "approximate" as const, topic: TROUBLE_TOPIC });
  }
  return facts;
}

/**
 * 쓰러뜨린 사람을 묶어 포로로 끌고 간다 (12-55, 12-184부터 handle_prisoner bind). 장면에 있고 크게 다친(중상 이상) 사람만.
 * 함께 다니며 우리 무리의 거점에 닿으면 우리 무리의 포로가 된다. 무소속이면 끌고만 다닌다
 */
function bindPrisoner(input: { target: string }, ctx: ToolContext): ToolOutcome {
  const { store, content } = ctx;
  const state = store.getState();
  const t = state.characters[input.target];
  if (!rules(content)) return { ok: false, error: "이 월드에는 포로 규칙이 없다." };
  if (heldOf(state.characters[state.playerId])) return { ok: false, error: "갇혀 있는 몸으로는 누구도 묶을 수 없다." };
  if (!t || t.dead || t.id === state.playerId || !state.scene.present.includes(t.id)) return { ok: false, error: "그 사람이 장면에 없다." };
  if (isCreature(content, t)) return { ok: false, error: "사람만 포로로 묶는다." };
  if (heldOf(t) || state.companions.includes(t.id)) return { ok: false, error: "그 사람은 이미 붙잡혀 있거나 함께 다니는 사람이다." };
  const track = harmTrack(content.scenario);
  const at = track.levels.findIndex((l) => l.id === t.conditions[track.id]);
  if (at < 2) return { ok: false, error: "아직 저항할 힘이 있다. 먼저 쓰러뜨리거나(크게 다치게) 이야기로 붙잡는다." };
  store.append({ type: "companion_joined", characterId: t.id, kind: "prisoner" });
  const name = playerCalls(state, content, t.id);
  // 이미 우리 무리의 거점이면 그 자리에서 가둔다
  const delivered = deliverPrisoners(ctx);
  return {
    ok: true,
    resultText: `${josa(name, "을/를")} 묶었다. ${delivered.length ? delivered.join(" ") : "끌고 다닌다 (우리 무리의 거점에 닿으면 우리 무리의 포로가 된다)."}`,
    display: { type: "presence", npcName: name, action: "enter" },
  };
}

const ACTIONS = ["bind", "interrogate", "recruit", "release", "ransom", "labor"] as const;

const handlePrisoner = defineTool({
  name: "handle_prisoner",
  description:
    "포로를 붙잡고 다룬다 (12-55). bind: 쓰러뜨린 사람(장면에 있고 중상 이상)을 묶어 끌고 간다. 우리 무리의 거점에 닿으면 우리 무리의 포로가 되고, 무소속이면 끌고만 다닌다. 죽이는 길이 아니다. " +
    "나머지는 우리 무리가 여기 가둔 포로(GM 상태의 '우리 무리가 여기 가둔 포로')나 끌고 다니는 포로에게: " +
    "interrogate 심문 (approach: 위협이나 교섭 스킬, 그 사람이 아는 것에서 시스템이 고른다), recruit 회유 (우리 무리로), release 풀어 준다, " +
    "ransom 몸값·맞교환 (그 무리에 우리 사람이 갇혀 있으면 맞바꾼다), labor 노역에 부린다/그만 부린다. 결과는 시스템이 정한다. 처형하는 길은 없다.",
  schema: z.strictObject({
    target: z.string(),
    action: z.enum(ACTIONS),
    approach: z.string().nullable().default(null).describe("심문·회유에 쓰는 스킬 id (아니면 null)"),
    stat: z.string().nullable().default(null).describe("그 스킬에 쓰는 능력 id (아니면 null)"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const c = rules(content);
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    const t = state.characters[input.target];
    if (!c) return { ok: false, error: "이 월드에는 포로 규칙이 없다." };
    if (input.action === "bind") return bindPrisoner(input, ctx);
    // 끌고 다니는 포로 (12-178): 거점에 닿기 전에도 그 자리에서 캐묻거나 풀어 줄 수 있다
    const towed = !!t && !t.dead && state.companions.includes(t.id) && state.bonds[t.id]?.kind === "prisoner";
    if (!towed && (!t || t.dead || !heldOf(t) || !me.factionId || heldOf(t)!.by !== me.factionId || heldOf(t)!.zone !== state.playerZone)) {
      return { ok: false, error: "여기 우리 무리가 가둔 포로도, 끌고 다니는 포로도 아니다." };
    }
    if (!t) return { ok: false, error: "없는 사람이다." };
    if (towed && input.action !== "interrogate" && input.action !== "release") {
      return { ok: false, error: "끌고 다니는 포로는 그 자리에서 심문하거나 풀어 줄 수만 있다. 회유·몸값·노역은 우리 거점에 데려간 뒤에." };
    }
    const name = playerCalls(state, content, t.id);
    const theirs = t.factionId;
    const roll = (moves: readonly string[]) => {
      if (!input.approach || !input.stat || !moves.includes(input.approach)) return { error: `approach는 ${moves.join("/")} 중 하나, stat은 그 스킬의 능력.` } as const;
      const trust = state.relations[t.id]?.[me.id]?.trust ?? 0;
      const difficulty = trust >= 2 ? "easy" : trust <= -2 ? "hard" : "normal";
      const r = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty, intent: `포로 ${name}` }, ctx);
      return r.ok ? ({ outcome: r.outcome, display: r.display } as const) : ({ error: r.error } as const);
    };
    const lines: string[] = [];
    let display: ToolDisplayEvent = { type: "presence", npcName: name, action: "enter" };

    if (input.action === "interrogate") {
      const r = roll(c.interrogate_moves);
      if ("error" in r) return { ok: false, error: r.error! };
      display = r.display;
      lines.push(`심문: ${CHECK_OUTCOME_LABELS[r.outcome]}.`);
      const threat = input.approach === "intimidate";
      if (threat) {
        recordDeed(ctx, { summary: `포로 ${josa(name, "을/를")} 윽박질러 심문했다`, tags: ["cruelty"], severity: 1, privacy: "semi_private", noisy: false });
        store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: -2, affection: -1, respect: 0 }, reason: "심문" });
      }
      if (r.outcome !== "miss") {
        const take = confessions(store.getState(), content, me.id, t, r.outcome === "success" ? 2 : 1, r.outcome === "success");
        for (const b of take) {
          store.append({
            type: "belief_added",
            characterId: me.id,
            belief: { id: `b_${store.getState().nextBeliefNo}`, fact: b.fact, source: "report", accuracy: b.accuracy, learnedAt: state.time, ...(b.topic ? { topic: b.topic } : {}) },
          });
          lines.push(`털어놓은 것: ${b.fact}`);
        }
        if (take.length === 0) lines.push("털어놓았지만 새로 알게 된 것은 없다.");
      } else lines.push(`${josa(name, "은/는")} 입을 다물었다.`);
    } else if (input.action === "recruit") {
      const r = roll([c.recruit_move]);
      if ("error" in r) return { ok: false, error: r.error! };
      display = r.display;
      if (r.outcome === "success") {
        store.append({ type: "npc_released", npcId: t.id });
        store.append({ type: "npc_departed", npcId: t.id, toFaction: me.factionId });
        lines.push(`회유: 성공. ${josa(name, "이/가")} 우리 무리에 들기로 했다.`);
        if (theirs && theirs !== me.factionId) lines.push(`${content.factions[theirs]?.name ?? theirs}에게는 배신자다.`);
      } else {
        store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: r.outcome === "partial" ? 1 : -1, affection: 0, respect: 0 }, reason: "회유" });
        lines.push(`회유: ${CHECK_OUTCOME_LABELS[r.outcome]}. ${r.outcome === "partial" ? "마음이 흔들리지만 아직은 아니다." : "고개를 돌렸다."}`);
      }
    } else if (input.action === "release") {
      if (towed) store.append({ type: "companion_left", characterId: t.id, reason: "풀어 줌" });
      else store.append({ type: "npc_released", npcId: t.id });
      store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: 2, affection: 1, respect: 0 }, reason: "풀어 줌" });
      if (theirs && me.factionId && theirs !== me.factionId && state.factions[theirs]) {
        const now = disposition(content, theirs, me.factionId, state);
        if (now < 3) store.append({ type: "faction_disposition_changed", from: theirs, to: me.factionId, value: now + 1 });
      }
      const { deed } = recordDeed(ctx, { summary: `포로 ${josa(name, "을/를")} 풀어 주었다`, tags: ["mercy"], severity: 1, privacy: "semi_private", noisy: false });
      lines.push(`${josa(name, "을/를")} 풀어 주었다. ${deed.summary}.`);
    } else if (input.action === "ransom") {
      if (!theirs || !state.factions[theirs] || theirs === me.factionId) return { ok: false, error: "몸값을 낼 무리가 없다." };
      if (disposition(content, theirs, me.factionId, state) <= -3) return { ok: false, error: "그 무리는 우리와 말도 섞지 않는다. 몸값도 맞교환도 없다." };
      // 그 무리에 갇힌 우리 사람이 있으면 맞바꾼다
      const ours = Object.values(state.characters).find((ch) => heldOf(ch)?.by === theirs && ch.factionId === me.factionId && !ch.dead && ch.id !== me.id);
      store.append({ type: "npc_released", npcId: t.id });
      if (ours) {
        store.append({ type: "npc_released", npcId: ours.id });
        lines.push(`맞교환: ${josa(name, "을/를")} 돌려보내고 ${josa(playerCalls(state, content, ours.id), "을/를")} 돌려받았다.`);
      } else {
        const pay = Math.min(c.ransom.amount, state.factions[theirs]!.resources[c.ransom.resource] ?? 0);
        if (pay > 0) {
          store.append({ type: "faction_resource_changed", factionId: theirs, resource: c.ransom.resource, delta: -pay });
          store.append({ type: "faction_resource_changed", factionId: me.factionId, resource: c.ransom.resource, delta: pay });
        }
        lines.push(`몸값을 받고 ${josa(name, "을/를")} 돌려보냈다${pay > 0 ? "" : " (그 무리는 낼 것이 없었다)"}.`);
      }
    } else {
      const labor = !heldOf(t)?.labor;
      store.append({ type: "prisoner_labor", npcId: t.id, labor });
      if (labor) store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: -1, affection: -1, respect: 0 }, reason: "노역" });
      lines.push(labor ? `${josa(name, "을/를")} 노역에 부린다. 무리가 날마다 조금 얻는다.` : `${name}의 노역을 멈췄다.`);
    }
    lines.push("이 결과에 맞게 장면을 서술한다. 숫자와 털어놓은 내용을 바꾸지 않는다.");
    return { ok: true, resultText: lines.join("\n"), display };
  },
});

const surrender = defineTool({
  name: "surrender",
  description: "전투 중에 무기를 버리고 항복한다 (12-55). 주인공은 적에게 붙잡히고, 남은 싸움은 시스템이 굴린다. 플레이어가 항복하겠다고 할 때만.",
  schema: z.strictObject({}),
  run(_input, ctx): ToolOutcome {
    const state = ctx.store.getState();
    const battle = state.battle;
    if (!battle) return { ok: false, error: "전투 중이 아니다." };
    if (!rules(ctx.content)) return { ok: false, error: "이 월드에는 포로 규칙이 없다." };
    const enemy = battle.theirs.faction;
    // 물러난 것처럼 남은 싸움은 코드가 굴리고, 주인공은 적의 손에 남는다
    const end = endBattle(ctx, true);
    const caught = capturePlayer(ctx, enemy, undefined, "무기를 버리고 항복했다");
    return {
      ok: true,
      resultText: ["항복했다.", ...end.lines, ...(caught ? [caught] : [])].join("\n"),
      display: end.displays[0] ?? { type: "battle", event: "ended", title: "항복", detail: "" },
      extra: end.displays.slice(1),
    };
  },
});

export const CAPTIVITY_TOOLS = [handlePrisoner, surrender] as const;

/** 끌고 온 포로를 우리 무리의 거점에 넘긴다 (지금 구역이 우리 무리의 거점일 때) */
export function deliverPrisoners(ctx: ToolContext): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me?.factionId || !zone || content.locations[zone]?.kind !== "base" || !ownedBy(state, zone, me.factionId)) return [];
  const lines: string[] = [];
  for (const id of state.companions) {
    if (state.bonds[id]?.kind !== "prisoner") continue;
    store.append({ type: "npc_captured", npcId: id, by: me.factionId, zone });
    lines.push(`끌고 온 ${josa(playerCalls(state, content, id), "을/를")} 거점에 가뒀다. 이제 우리 무리의 포로다 (handle_prisoner).`);
  }
  return lines;
}
