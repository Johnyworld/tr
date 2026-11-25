import { warConfessions } from "./partyTools.ts";
import { stakesOf } from "../rules/stakes.ts";
import { formatDuration, routeMinutes } from "../rules/time.ts";
import { onCaptured } from "../rules/consequence.ts";
import {heldByOwn, heldOf, heldKind, heldSeenTopic } from "../rules/held.ts";
import { formatTime } from "../rules/time.ts";
import { z } from "zod";
import { isCreature } from "../game/kinds.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Clash, GameState } from "../game/state.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { harmTrack, incapacitatingSymptom, moveOf } from "../scenario/scenario.ts";
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
import {ownedBy, baseOfNow } from "../rules/home.ts";
import { learned } from "../rules/skill.ts";
import { hearNews } from "../rules/news.ts";
import { protectedFromWorld } from "../rules/company.ts";
import { killQuestGiver } from "../rules/request.ts";
import { currentPlace, jailFor, jailIn, knowsPlace, placeById, unknownDoors, whereIs } from "../rules/place.ts";
import { againstSetting } from "../rules/self.ts";
import { changeCondition, isIncapacitated } from "./body.ts";
import { alarmIfInfiltrating } from "./infiltration.ts";
import { changeRelation } from "../rules/regard.ts";

/**
 * 포로 (기획서 7.6, 12-55).
 * - 주인공도 붙잡힌다: 진 전투에서 물러나지 않았으면 빠져나가기 판정에 실패해서(12-220), 항복하면 반드시, 이야기 효과로. 죽음 대신 갇힌다 (원칙 3: 코드가 정한다)
 *   갇힌 동안: 무기·탄은 빼앗기고(풀려나면 돌려받는다), 갇힌 구역에 묶이고, 갇힌 동안의 이야기(captivity.tag)만 열린다. 탈출은 무거운 위험을 건 판정
 * - 주인공이 포로를 잡는다: 크게 다친 사람을 묶어 끌고 가고(동행 prisoner), 우리 거점에 닿으면 우리 무리의 포로가 된다
 * - 포로를 다룬다: 심문(그 사람이 아는 것에서 코드가 고른다), 회유, 석방, 몸값·맞교환, 노역. 포로는 붙잡은 무리의 먹을 것을 먹는다
 * - 무리 사이 싸움에서 이긴 쪽이 이름 있는 사람을 붙잡아 가기도 한다
 */

const rules = (content: Content) => content.scenario.captivity;
/** 그 무리의 지금 거점 (공통 규칙 11 baseOfNow) */
export const baseOf = (state: GameState, content: Content, faction: string | null | undefined) => baseOfNow(state, content, faction) ?? undefined;

/**
 * 주인공이 붙잡힌다. 갇히는 곳은 zone이 있으면 그 구역(가두는 장소가 있으면 그 장소),
 * 없으면 공통 규칙 15의 jailFor: 붙잡힌 구역에 그 무리의 가두는 장소가 있으면 그곳, 아니면 가두는 장소가 있는 그 무리 땅(거점 먼저). 돌려줄 한 줄
 */
export function capturePlayer(ctx: ToolContext, by: string, zone?: string, cause = "붙잡혔다"): string | null {
  const { store, content } = ctx;
  const c = rules(content);
  const state = store.getState();
  const me = state.characters[state.playerId];
  const jail = zone ? { zone, place: jailIn(content, zone)?.id ?? null } : jailFor(state, content, by, state.playerZone);
  const where = jail?.zone;
  if (!c || !me || me.dead || heldOf(me) || !jail || !where || !content.factions[by] || by === me.factionId) return null;
  // 동행은 그 자리에 남는다 (끌고 가던 포로는 풀려난다). 임무 짝은 자기 자리로 돌아가 알린다 (플레이 테스트 13: 적 거점에서 이틀을 기다리다 다시 합류했다)
  // 누가 어떻게 됐는지 적는다 (PT14 경비: "함께 있던 사람은 따라오지 못했다"뿐이라 짝의 행방을 끝내 몰랐다)
  const fates: string[] = [];
  const spot = currentPlace(state, content);
  // 곁에서 본 사람은 붙잡힌 것을 직접 안다: 계승하면 그 사람이 구하러 갈 실마리 (12-262, PT17 졸병: 짝이 본 붙잡힘이 믿음에 없었다)
  const captor = content.factions[by]?.name ?? by;
  const placeName = content.locations[where]?.name ?? where;
  for (const id of state.scene.present) {
    const c0 = state.characters[id];
    if (!c0 || c0.dead || !content.npcs[id] && !c0.extra) continue;
    const s1 = store.getState();
    store.append({ type: "belief_added", characterId: id, belief: { id: `b_${s1.nextBeliefNo}`, fact: `${josa(me.name, "이/가")} ${captor}에게 붙잡혀 ${josa(placeName, "으로/로")} 끌려갔다`, source: "seen", accuracy: "exact", learnedAt: s1.time } });
  }
  for (const id of state.companions) {
    const kind = state.bonds[id]?.kind;
    const who = playerCalls(state, content, id);
    if (kind === "prisoner" || kind === "buddy") {
      store.append({ type: "companion_left", characterId: id, reason: kind === "buddy" ? "짝이 붙잡혀 혼자 돌아갔다" : "풀려났다" });
      fates.push(kind === "buddy" ? `짝 ${josa(who, "은/는")} 붙잡히지 않고 혼자 돌아가 알린다` : `끌고 가던 ${josa(who, "은/는")} 풀려났다`);
    } else if (state.playerZone) {
      store.append({ type: "companion_parted", characterId: id, zone: state.playerZone, until: null, place: spot?.id ?? null });
      fates.push(`${josa(who, "은/는")} 붙잡힌 자리에 남았다 (풀려나 그곳에 가면 다시 합류한다)`);
    }
  }
  const held = Object.fromEntries(Object.entries(me.inventory).filter(([id, n]) => n > 0 && (c.confiscate.includes(content.items[id]?.kind ?? "") || c.confiscate_items.includes(id))));
  const taken = Object.entries(held).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`);
  // 붙잡힌 결과는 공통 규칙 3 (rules/consequence.ts): 들키지 않기 임무, 침입 행적, 그 무리의 태도
  const spotted = onCaptured(ctx, by).join(" ");
  // 다른 구역으로 끌려가면 그 길의 이동 시간이 흐른다 (사용자 결정, 플레이 테스트 14: 물류창고에서 붙잡혔는데 0분 만에 거점에 갇혔다)
  const dragged = state.playerZone && where !== state.playerZone ? routeMinutes(state.playerZone, where, ctx.content) : 0;
  if (dragged > 0) {
    const now = store.getState().time;
    store.append({ type: "time_advanced", activity: "travel", from: now, to: now + dragged });
  }
  store.append({ type: "player_captured", by, zone: where, held, place: jail.place });
  // 우리 무리가 붙잡힌 것을 안다: 곁에서 본 우리 무리 사람, 혼자 돌아가 알리는 짝 (12-264, PT17 졸병: 짝이 돌아가 알렸는데 구하러 오는 이야기가 짐꾼 판정에만 걸려 있었다)
  const told = !!me.factionId && (state.scene.present.some((id) => id !== me.id && state.characters[id]?.factionId === me.factionId && !state.characters[id]?.dead && !heldOf(state.characters[id])) || state.companions.some((id) => state.bonds[id]?.kind === "buddy"));
  if (told && c.known_flag) store.append({ type: "flag_set", characterId: me.id, flag: c.known_flag });
  const name = content.factions[by]!.name;
  const cell = jail.place ? jailIn(content, where)?.name : null;
  const fact = sentence(`${cause}. ${name}에 붙잡혀 ${dragged > 0 ? `${formatDuration(dragged)} 동안 끌려가 ` : ""}${content.locations[where]?.name ?? where}${cell ? `의 ${cell}` : ""}에 갇혔다`);
  store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${store.getState().nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
  return (
    // 빼앗긴 것을 하나하나 적는다 (PT14 경비: "무기와 탄"이라 했는데 쌍안경·손전등도 사라졌다)
    `${fact} ${taken.length ? `빼앗긴 것: ${taken.join(", ")} (풀려나는 길에 따라 돌려받는다).` : "빼앗긴 것은 없다."}${fates.length ? ` ${fates.join(". ")}.` : ""} ${spotted ? `${spotted} ` : ""}` +
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
  const known = rules(ctx.content)?.known_flag;
  if (known && (ctx.store.getState().flags[state.playerId] ?? []).includes(known)) ctx.store.append({ type: "flag_cleared", characterId: state.playerId, flag: known });
  if (returned) return taken.length ? `풀려났다. 빼앗겼던 것을 돌려받았다 (${taken.join(", ")}).` : "풀려났다.";
  return `빠져나왔다. 빼앗긴 것은 그곳에 두고 왔다${taken.length ? `: ${taken.join(", ")}` : ""}.${taken.length ? " 맨손이면 우리 거점의 무기고가 근접 무기 하나를 내준다." : ""}`;
}

/** 빠져나가기에 가장 나은 판정: flee_moves 중 능력 + 스킬이 가장 높은 것 (배우지 않은 전문 기술은 빼고) */
function bestFlee(content: Content, me: Character, moves: string[]): { move: string; stat: string } | null {
  let best: { move: string; stat: string; value: number } | null = null;
  for (const id of moves) {
    const m = moveOf(content.scenario, id);
    const skill = learned(content.scenario, me.skills, id);
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
  const roll = rollPlayerCheck({ move: flee.move, stat: flee.stat, difficulty: "normal", intent: "진 싸움터에서 빠져나간다" }, ctx, { stakes: stakesOf({ battle: true }) });
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
      // 세계가 건드리지 않는 사람은 빼고, 붙잡혀 갈 수 있는 계급만 (공통 규칙 8, 12-243)
      .filter((ch) => ch.factionId === loser && !!ctx.content.npcs[ch.id] && !protectedFromWorld(state, ctx.content, ch.id))
      .filter((ch) => !c.war_capture_ranks.length || c.war_capture_ranks.includes(ch.rank))
      .sort((a, b) => a.id.localeCompare(b.id));
    const taken = pool[Math.floor(ctx.rng() * pool.length)];
    const zone = baseOf(ctx.store.getState(), ctx.content, winner);
    if (!taken || !zone) continue;
    captureNpc(ctx, taken.id, winner, zone);
    // 우리 무리 사람이 끌려갔으면 소식으로, 남의 무리면 만난 사람만 소문으로 (공통 규칙 14). 이름을 아는 사람만
    if ((state.known[state.playerId] ?? []).includes(taken.id)) {
      const fact = sentence(`${josa(playerCalls(state, ctx.content, taken.id), "이/가")} ${josa(ctx.content.factions[winner]?.name ?? winner, "과/와")}의 싸움에서 붙잡혀 갔다고 한다`);
      displays.push(...hearNews(ctx, { fact, factions: [loser], person: taken.id, topic: "war", showOursOnly: true }));
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
  const kind = heldKind(state);
  if (kind === "quarantine") {
    // 격리 (12-238): 빼앗긴 것도 탈출 안내도 없다 (12-269, 우회 점검: 적의 포로 글이 나왔다)
    const h = heldOf(me)!;
    lines.push(`주인공은 ${content.factions[h.by]?.name ?? h.by}의 격리로 ${content.locations[h.zone]?.name ?? h.zone}에 있다.${h.releaseAt ? ` ${formatTime(h.releaseAt)}에 풀린다.` : ""} 지닌 것은 그대로고 끼니는 그쪽이 준다. 달아나면 격리를 깬 것이다.`);
  } else if (kind === "own") {
    // 우리 무리의 벌 (12-261, PT16 졸병: "무기와 탄은 빼앗겼다"·탈출 안내가 그대로 나왔다)
    const h = heldOf(me)!;
    lines.push(`주인공은 우리 무리(${content.factions[h.by]?.name ?? h.by})의 벌로 ${content.locations[h.zone]?.name ?? h.zone}에 갇혀 있다.${h.releaseAt ? ` ${formatTime(h.releaseAt)}에 풀린다.` : ""} 지닌 것은 그대로다. 달아나면 무리의 벌을 어긴 것이다. 갇힌 동안 적의 포로 이야기는 열리지 않는다.`);
  } else if (kind === "enemy") {
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
 * 심문으로 털어놓는 장소 (설계 목록 C-1 2단계): 그 사람 무리가 가둔 사람의 정확한 자리, 남는 몫은 그 무리 땅이면 지금 자리의 문 너머.
 * 주인공이 그 장소를 알게 된다 (place_learned). 성공이면 갇힌 자리 모두와 문 둘까지, 대가 있는 성공이면 하나
 */
function placeConfessions(ctx: ToolContext, t: Character, full: boolean): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const lines: string[] = [];
  const learn = (zone: string, place: string, line: string) => {
    store.append({ type: "place_learned", zone, place });
    lines.push(line);
  };
  for (const c of Object.values(state.characters)) {
    if (!full && lines.length) break;
    const held = heldOf(c);
    if (c.dead || c.id === state.playerId || !held || held.by !== t.factionId) continue;
    const at = whereIs(state, content, c.id);
    if (!at?.zone || !at.place || knowsPlace(state, content, at.zone, at.place)) continue;
    const p = placeById(state, content, at.place, at.zone);
    if (!p) continue;
    learn(at.zone, p.id, `털어놓은 것: ${josa(playerCalls(state, content, c.id), "은/는")} ${content.locations[at.zone]?.name ?? at.zone}의 ${p.name}(${p.id})에 갇혀 있다.`);
    // 어디 갇혔는지 알게 됐다: 풀어 주기 목표가 열린다 (PT23 졸병: 심문으로 수용소를 알아도 직접 봐야 열렸다)
    const s1 = store.getState();
    if (!(s1.beliefs[s1.playerId] ?? []).some((b) => b.topic === heldSeenTopic(c.id, at.zone!))) {
      store.append({ type: "belief_added", characterId: s1.playerId, belief: { id: `b_${s1.nextBeliefNo}`, fact: `${josa(playerCalls(s1, content, c.id), "은/는")} ${content.locations[at.zone]?.name ?? at.zone}의 ${p.name}에 갇혀 있다`, source: "report", accuracy: "exact", learnedAt: s1.time, topic: heldSeenTopic(c.id, at.zone) } });
    }
  }
  if (state.playerZone && ownedBy(state, state.playerZone, t.factionId)) {
    const limit = full ? 2 : lines.length ? 0 : 1;
    const here = currentPlace(state, content);
    // 문 번호는 알게 되면 바뀌니 이름으로 적는다
    for (const p of unknownDoors(store.getState(), content).slice(0, limit)) learn(state.playerZone, p.id, `털어놓은 것: ${here ? `${here.name} 옆` : "이 근처"}에 ${p.name}(${p.id})${p.indoor ? "" : " (바깥)"}이 있다.`);
  }
  return lines;
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

const ACTIONS = ["bind", "interrogate", "recruit", "release", "ransom", "labor", "knock_out", "kill"] as const;

const handlePrisoner = defineTool({
  name: "handle_prisoner",
  description:
    "포로를 붙잡고 다룬다 (12-55). bind: 쓰러뜨린 사람(장면에 있고 중상 이상)을 묶어 끌고 간다. 우리 무리의 거점에 닿으면 우리 무리의 포로가 되고, 무소속이면 끌고만 다닌다. 죽이는 길이 아니다. " +
    "나머지는 우리 무리가 여기 가둔 포로(GM 상태의 '우리 무리가 여기 가둔 포로')나 끌고 다니는 포로에게: " +
    "interrogate 심문 (approach: 위협이나 교섭 스킬, 그 사람이 아는 것에서 시스템이 고른다), recruit 회유 (우리 무리로), release 풀어 준다, " +
    "ransom 몸값·맞교환 (그 무리에 우리 사람이 갇혀 있으면 맞바꾼다), labor 노역에 부린다/그만 부린다. " +
    "끌고 다니는 포로는 그 자리에서 knock_out 기절시켜 두고 간다 (얼굴을 본 사람으로 행적이 남는다), kill 죽인다 (무거운 행적, 플레이어가 분명히 그러겠다고 할 때만. 설정을 거스르면 against_setting). 잠입 중에 놓아주면 그 사람이 알린다. 결과는 시스템이 정한다.",
  schema: z.strictObject({
    target: z.string(),
    action: z.enum(ACTIONS),
    approach: z.string().nullable().default(null).describe("심문·회유에 쓰는 스킬 id (아니면 null)"),
    stat: z.string().nullable().default(null).describe("그 스킬에 쓰는 능력 id (아니면 null)"),
    against_setting: z.string().nullable().default(null).describe("이 처리가 주인공의 설정(이상·금기·결점)을 거스르면 그 설정 id (take_action과 같다). 아니면 null"),
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
    // 장면에 쓰러져(무력화) 있는 사람·감염체는 그 자리에서 끝내거나(kill) 기절시켜 둘(knock_out) 수 있다 (PT23 분대장: "판정 없이 끝내라"는 안내에 끝낼 길이 없었다)
    const downed = !!t && !t.dead && !towed && state.scene.present.includes(t.id) && !state.companions.includes(t.id) && isIncapacitated(content, t) && (input.action === "kill" || (input.action === "knock_out" && !isCreature(content, t)));
    if (!towed && !downed && (!t || t.dead || !heldOf(t) || !me.factionId || heldOf(t)!.by !== me.factionId || heldOf(t)!.zone !== state.playerZone)) {
      return { ok: false, error: "여기 우리 무리가 가둔 포로도, 끌고 다니는 포로도 아니다." };
    }
    if (!t) return { ok: false, error: "없는 사람이다." };
    if (towed && !["interrogate", "release", "knock_out", "kill"].includes(input.action)) {
      return { ok: false, error: "끌고 다니는 포로는 그 자리에서 심문하거나, 풀어 주거나, 기절시켜 두거나, 죽일 수만 있다. 회유·몸값·노역은 우리 거점에 데려간 뒤에." };
    }
    if (!towed && !downed && (input.action === "knock_out" || input.action === "kill")) return { ok: false, error: "기절시켜 두거나 죽이는 것은 끌고 다니는 포로나 장면에 쓰러진 상대에게만 (그 자리에서)." };
    const name = playerCalls(state, content, t.id);
    const settingLines: string[] = [];
    let settingDisplays: ToolDisplayEvent[] = [];
    if (input.against_setting) {
      const r = againstSetting(ctx, input.against_setting);
      if (!r.ok) return { ok: false, error: r.error };
      settingLines.push(...r.lines);
      settingDisplays = r.displays;
      if (!r.proceed) return { ok: true, resultText: settingLines.join("\n"), display: settingDisplays[0] ?? { type: "presence", npcName: name, action: "enter" }, extra: settingDisplays.slice(1) };
    }
    const theirs = t.factionId;
    const roll = (moves: readonly string[]) => {
      if (!input.approach || !input.stat || !moves.includes(input.approach)) return { error: `approach는 ${moves.join("/")} 중 하나, stat은 그 스킬의 능력.` } as const;
      const trust = state.relations[t.id]?.[me.id]?.trust ?? 0;
      const difficulty = trust >= 4 ? "easy" : trust <= -4 ? "hard" : "normal";
      const r = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty, intent: `포로 ${name}` }, ctx, { stakes: stakesOf({ opponent: true }) });
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
        changeRelation(ctx, { from: t.id, to: me.id, delta: { trust: -2, affection: -1, respect: 0 }, reason: "심문", kind: "captivity" });
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
        // 전쟁 이야기도 털어놓는다 (움직이는 부대 6-2): 나가 있는 부대의 목표, 다음 공세의 목표. 대가 있는 성공이면 반은 틀린 말
        for (const w of warConfessions(store.getState(), content, ctx.rng, t.id, r.outcome === "success" ? "success" : "partial")) {
          store.append({ type: "belief_added", characterId: me.id, belief: { id: `b_${store.getState().nextBeliefNo}`, fact: w.fact, source: "report", accuracy: w.accuracy, learnedAt: state.time, topic: "war" } });
          lines.push(`털어놓은 것: ${w.fact}`);
          take.push({ fact: w.fact, accuracy: w.accuracy, topic: "war" });
        }
        // 장소도 털어놓는다 (설계 목록 C-1 2단계)
        const places = placeConfessions(ctx, t, r.outcome === "success");
        lines.push(...places);
        if (take.length === 0 && places.length === 0) lines.push("털어놓았지만 새로 알게 된 것은 없다.");
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
        changeRelation(ctx, { from: t.id, to: me.id, delta: { trust: r.outcome === "partial" ? 1 : -1, affection: 0, respect: 0 }, reason: "회유", kind: "coax" });
        lines.push(`회유: ${CHECK_OUTCOME_LABELS[r.outcome]}. ${r.outcome === "partial" ? "마음이 흔들리지만 아직은 아니다." : "고개를 돌렸다."}`);
      }
    } else if (input.action === "release") {
      if (towed) store.append({ type: "companion_left", characterId: t.id, reason: "풀어 줌" });
      else store.append({ type: "npc_released", npcId: t.id });
      changeRelation(ctx, { from: t.id, to: me.id, delta: { trust: 2, affection: 1, respect: 0 }, reason: "풀어 줌", kind: "release" });
      if (theirs && me.factionId && theirs !== me.factionId && state.factions[theirs]) {
        const now = disposition(content, theirs, me.factionId, state);
        if (now < 3) store.append({ type: "faction_disposition_changed", from: theirs, to: me.factionId, value: now + 1 });
      }
      const { deed } = recordDeed(ctx, { summary: `포로 ${josa(name, "을/를")} 풀어 주었다`, tags: ["mercy"], severity: 1, privacy: "semi_private", noisy: false });
      lines.push(`${josa(name, "을/를")} 풀어 주었다. ${deed.summary}.`);
      // 잠입 중에 놓아주면 그 사람이 곧장 알린다 (설계 목록 C-1 2단계)
      if (towed && t.factionId === store.getState().infiltration?.owner) lines.push(`${josa(name, "이/가")} 달려가 알린다.`, ...alarmIfInfiltrating(ctx, 2));
    } else if (input.action === "knock_out") {
      // 기절시켜 두고 간다: 깨어나면 얼굴을 본 사람이다 (행적의 목격자, 관계)
      if (towed) store.append({ type: "companion_left", characterId: t.id, reason: "기절시켜 두고 감" });
      store.append({ type: "npc_left", npcId: t.id });
      // 네 시간쯤 깨어나지 못한다: 그동안 보지도 움직이지도 못한다 (공통 규칙 8 ableNow)
      store.append({ type: "npc_knocked_out", npcId: t.id, until: store.getState().time + 240 });
      changeRelation(ctx, { from: t.id, to: me.id, delta: { trust: -2, affection: -1, respect: 0 }, reason: "붙잡혀 기절했다", kind: "captivity" });
      recordDeed(ctx, { summary: `${josa(name, "을/를")} 붙잡아 기절시키고 두고 갔다`, tags: ["trespass"], severity: 1, privacy: "private", noisy: false }, { npcId: t.id, source: "seen" });
      lines.push(`${josa(name, "을/를")} 기절시켜 두고 왔다. 몇 시간은 깨어나지 못하고, 깨어나면 주인공의 얼굴을 기억한다.`);
    } else if (input.action === "kill") {
      // 죽인다: 상처 트랙의 끝으로 코드가 정한다 (원칙 3: 사망은 상태 트랙의 끝으로만). 무거운 행적, 숨은 목격자는 행적 규칙대로
      if (towed) store.append({ type: "companion_left", characterId: t.id, reason: "죽임" });
      const track = harmTrack(content.scenario);
      changeCondition(ctx, t.id, track.id, track.levels.length, "player", towed ? "붙잡혀 죽임을 당했다" : "쓰러진 채 숨이 끊겼다");
      // 감염체를 끝내는 것은 행적이 아니다. 쓰러진 사람·묶인 포로를 죽이는 것은 무거운 행적
      if (isCreature(content, t)) lines.push(`${josa(name, "을/를")} 끝냈다.`);
      else if (killQuestGiver(state, t.id)) {
        // 처치하기 의뢰의 목표(무법자)를 끝냈다: 맡긴 일이라 무거운 잔혹이 아니고, 의뢰인은 이미 보수로 반응한다 (12-294, PT26 분대장: 의뢰를 해냈는데 잔혹 행적·규율 회의·수용소)
        const giver = killQuestGiver(state, t.id)!;
        const { deed } = recordDeed(ctx, { summary: `맡은 의뢰대로 쓰러진 ${josa(name, "을/를")} 끝냈다`, tags: ["cruelty"], severity: 1, privacy: "private", noisy: false }, { npcId: giver, source: "report", only: "none" });
        lines.push(`${josa(name, "을/를")} 죽였다. ${deed.summary}.`);
      } else {
        const { deed } = recordDeed(ctx, { summary: `${towed ? "붙잡은" : "쓰러진"} ${josa(name, "을/를")} 죽였다`, tags: ["cruelty"], severity: 3, privacy: "private", noisy: false });
        lines.push(`${josa(name, "을/를")} 죽였다. ${deed.summary}.`);
      }
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
      if (labor) changeRelation(ctx, { from: t.id, to: me.id, delta: { trust: -1, affection: -1, respect: 0 }, reason: "노역", kind: "captivity" });
      lines.push(labor ? `${josa(name, "을/를")} 노역에 부린다. 무리가 날마다 조금 얻는다.` : `${name}의 노역을 멈췄다.`);
    }
    lines.push("이 결과에 맞게 장면을 서술한다. 숫자와 털어놓은 내용을 바꾸지 않는다.");
    return { ok: true, resultText: [...settingLines, ...lines].join("\n"), display, ...(settingDisplays.length ? { extra: settingDisplays } : {}) };
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
    captureNpc(ctx, id, me.factionId, zone);
    lines.push(`끌고 온 ${josa(playerCalls(state, content, id), "을/를")} 거점에 가뒀다. 이제 우리 무리의 포로다 (handle_prisoner).`);
  }
  return lines;
}

/**
 * 인물을 가둔다: 무기는 빼앗는다 (PT15 튜토리얼: 수용소의 포로가 쇠지렛대를 지닌 채였다). 주인공이 갇힐 때와 같다
 */
export function captureNpc(ctx: ToolContext, npcId: string, by: string, zone: string): void {
  const c = ctx.store.getState().characters[npcId];
  for (const [itemId, qty] of Object.entries(c?.inventory ?? {})) {
    if (qty > 0 && ctx.content.items[itemId]?.weapon) ctx.store.append({ type: "item_consumed", holder: npcId, itemId, quantity: qty });
  }
  ctx.store.append({ type: "npc_captured", npcId, by, zone });
}
