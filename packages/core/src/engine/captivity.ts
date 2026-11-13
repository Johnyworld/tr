import { z } from "zod";
import { playerCalls } from "../game/acquaintance.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Clash, GameState } from "../game/state.ts";
import { CHECK_OUTCOME_LABELS } from "../rules/check.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { disposition } from "../sim/war.ts";
import { josa, sentence } from "../text.ts";
import type { Content } from "../content/schemas.ts";
import { endBattle } from "./battleTools.ts";
import { rollPlayerCheck } from "./checks.ts";
import { recordDeed } from "./reputationTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 포로 (기획서 7.6, 12-55).
 * - 주인공도 붙잡힌다: 진 전투에서 물러나지 않았으면 부상 단계별 확률로, 항복하면 반드시, 이야기 효과로. 죽음 대신 갇힌다 (원칙 3: 코드가 정한다)
 *   갇힌 동안: 무기·탄은 빼앗기고(풀려나면 돌려받는다), 갇힌 구역에 묶이고, 갇힌 동안의 이야기(captivity.tag)만 열린다. 탈출은 무거운 위험을 건 판정
 * - 주인공이 포로를 잡는다: 크게 다친 사람을 묶어 끌고 가고(동행 prisoner), 우리 거점에 닿으면 우리 무리의 포로가 된다
 * - 포로를 다룬다: 심문(그 사람이 아는 것에서 코드가 고른다), 회유, 석방, 몸값·맞교환, 노역. 포로는 붙잡은 무리의 먹을 것을 먹는다
 * - 무리 사이 싸움에서 이긴 쪽이 이름 있는 사람을 붙잡아 가기도 한다
 */

const rules = (content: Content) => content.scenario.captivity;
const baseOf = (content: Content, faction: string) => Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")?.id;

/** 주인공이 붙잡힌다. 갇히는 곳은 zone이 없으면 붙잡은 무리의 거점. 돌려줄 한 줄 */
export function capturePlayer(ctx: ToolContext, by: string, zone?: string, cause = "붙잡혔다"): string | null {
  const { store, content } = ctx;
  const c = rules(content);
  const state = store.getState();
  const me = state.characters[state.playerId];
  const where = zone ?? baseOf(content, by);
  if (!c || !me || me.dead || me.captive || !where || !content.factions[by] || by === me.factionId) return null;
  // 동행은 그 자리에 남는다 (끌고 가던 포로는 풀려난다)
  for (const id of state.companions) {
    if (state.bonds[id]?.kind === "prisoner") store.append({ type: "companion_left", characterId: id });
    else if (state.playerZone) store.append({ type: "companion_parted", characterId: id, zone: state.playerZone, until: null });
  }
  const held = Object.fromEntries(Object.entries(me.inventory).filter(([id, n]) => n > 0 && c.confiscate.includes(content.items[id]?.kind ?? "")));
  store.append({ type: "player_captured", by, zone: where, held });
  const name = content.factions[by]!.name;
  const fact = sentence(`${cause}. ${name}에 붙잡혀 ${content.locations[where]?.name ?? where}에 갇혔다`);
  store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${store.getState().nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
  return (
    `${fact} 무기와 탄은 빼앗겼다. 함께 있던 사람은 따라오지 못했다. ` +
    `갇힌 동안에는 갇힌 곳의 이야기만 열린다. 빠져나가려면 맞닿은 구역으로 옮겨 가는 행동에 ${c.escape_moves.join("/")} 판정과 무거운 위험(heavy)을 건다.`
  );
}

/** 주인공이 풀려난다 (빼앗긴 것을 돌려받는지는 어떻게 풀려나는지에 따라) */
export function releasePlayer(ctx: ToolContext, returned: boolean): string | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me?.captive) return null;
  ctx.store.append({ type: "player_released", returned });
  return returned ? "풀려났다. 빼앗겼던 것을 돌려받았다." : "빠져나왔다. 빼앗긴 것은 그곳에 두고 왔다.";
}

/** 진 전투 뒤: 물러나지 않았고 살아 있으면 부상 단계별 확률로 붙잡힌다 */
export function maybeCaptureAfterDefeat(ctx: ToolContext, enemy: string): string | null {
  const c = rules(ctx.content);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!c || !me || me.dead) return null;
  const track = harmTrack(ctx.content.scenario);
  const chance = c.on_defeat[me.conditions[track.id] ?? ""] ?? 0;
  if (ctx.rng() >= chance) return null;
  return capturePlayer(ctx, enemy, undefined, "싸움에 지고 쓰러진 채로 끌려갔다");
}

/** 포로를 하루 먹이고 부린다: 붙잡은 무리의 먹을 것이 줄고, 노역이면 자원이 는다 */
export function runCaptivity(ctx: ToolContext): void {
  const c = rules(ctx.content);
  if (!c) return;
  const state = ctx.store.getState();
  const cost: Record<string, number> = {};
  const gain: Record<string, number> = {};
  for (const ch of Object.values(state.characters)) {
    if (!ch.captive || ch.dead) continue;
    cost[ch.captive.by] = (cost[ch.captive.by] ?? 0) + c.upkeep.amount;
    if (ch.captive.labor) gain[ch.captive.by] = (gain[ch.captive.by] ?? 0) + c.labor.amount;
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
      .filter((ch) => ch.factionId === loser && ch.id !== state.playerId && !ch.dead && !ch.away && !ch.captive && ctx.content.npcs[ch.id])
      .filter((ch) => ["grunt", "squad_leader"].includes(ch.rank) && !state.companions.includes(ch.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const taken = pool[Math.floor(ctx.rng() * pool.length)];
    const zone = baseOf(ctx.content, winner);
    if (!taken || !zone) continue;
    ctx.store.append({ type: "npc_captured", npcId: taken.id, by: winner, zone });
    const me = state.characters[state.playerId];
    if (me && !me.dead && me.factionId === loser && (state.known[state.playerId] ?? []).includes(taken.id)) {
      const fact = sentence(`${playerCalls(state, ctx.content, taken.id)}이(가) ${ctx.content.factions[winner]?.name ?? winner}과(와)의 싸움에서 붙잡혀 갔다고 한다`);
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
  if (!c || !me?.captive) return null;
  if (!check || !c.escape_moves.includes(check.move) || check.harm_on_failure !== "heavy") {
    return `갇혀 있다 (${content.factions[me.captive.by]?.name ?? me.captive.by}). 빠져나가려면 check.move를 ${c.escape_moves.join("/")} 중 하나로, harm_on_failure를 heavy로 위험을 먼저 선언한다 (실패하면 다치고 그대로 갇혀 있다). 아니면 이야기로 풀려나는 길을 찾는다.`;
  }
  return null;
}

/** GM 상태: 주인공이 갇혀 있으면, 그리고 우리 땅에 있으면 여기 갇힌 우리 포로 */
export function describeCaptivityForGm(state: GameState, content: Content): string {
  const me = state.characters[state.playerId];
  if (!me) return "";
  const lines: string[] = [];
  if (me.captive) {
    const c = rules(content);
    lines.push(
      `주인공은 갇혀 있다: ${content.factions[me.captive.by]?.name ?? me.captive.by}의 ${content.locations[me.captive.zone]?.name ?? me.captive.zone}. ` +
        `무기와 탄은 빼앗겼다. 갇힌 동안의 이야기만 열린다. 탈출은 이동에 ${c?.escape_moves.join("/") ?? "?"} 판정 + 무거운 위험`,
    );
  }
  const here = Object.values(state.characters).filter((ch) => ch.captive && ch.captive.by === me.factionId && ch.captive.zone === state.playerZone && !ch.dead && ch.id !== me.id);
  if (here.length && me.factionId) {
    lines.push(
      `우리 무리가 여기 가둔 포로 (handle_prisoner로 다룬다): ${here
        .map((ch) => `${playerCalls(state, content, ch.id)} (${ch.id}, ${content.factions[ch.factionId]?.name ?? "무리 없음"}${ch.captive!.labor ? ", 노역 중" : ""})`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

const takePrisoner = defineTool({
  name: "take_prisoner",
  description:
    "쓰러뜨린 사람을 묶어 포로로 끌고 간다 (12-55). 장면에 있고 크게 다친(중상 이상) 사람만. 함께 다니며 우리 무리의 거점에 닿으면 우리 무리의 포로가 된다. " +
    "무소속이면 끌고만 다닌다. 죽이는 도구가 아니다.",
  schema: z.strictObject({ target: z.string().describe("묶을 사람의 id") }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const t = state.characters[input.target];
    if (!rules(content)) return { ok: false, error: "이 월드에는 포로 규칙이 없다." };
    if (state.characters[state.playerId]?.captive) return { ok: false, error: "갇혀 있는 몸으로는 누구도 묶을 수 없다." };
    if (!t || t.dead || t.id === state.playerId || !state.scene.present.includes(t.id)) return { ok: false, error: "그 사람이 장면에 없다." };
    if (t.captive || state.companions.includes(t.id)) return { ok: false, error: "그 사람은 이미 붙잡혀 있거나 함께 다니는 사람이다." };
    const track = harmTrack(content.scenario);
    const at = track.levels.findIndex((l) => l.id === t.conditions[track.id]);
    if (at < 2) return { ok: false, error: "아직 저항할 힘이 있다. 먼저 쓰러뜨리거나(크게 다치게) 이야기로 붙잡는다." };
    store.append({ type: "companion_joined", characterId: t.id, kind: "prisoner" });
    const name = playerCalls(state, content, t.id);
    return {
      ok: true,
      resultText: `${josa(name, "을/를")} 묶었다. 끌고 다닌다 (우리 무리의 거점에 닿으면 우리 무리의 포로가 된다).`,
      display: { type: "presence", npcName: name, action: "enter" },
    };
  },
});

const ACTIONS = ["interrogate", "recruit", "release", "ransom", "labor"] as const;

const handlePrisoner = defineTool({
  name: "handle_prisoner",
  description:
    "우리 무리가 여기 가둔 포로를 다룬다 (12-55, GM 상태의 '우리 무리가 여기 가둔 포로'). " +
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
    if (!t || t.dead || !t.captive || !me.factionId || t.captive.by !== me.factionId || t.captive.zone !== state.playerZone) {
      return { ok: false, error: "여기 우리 무리가 가둔 포로가 아니다." };
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
        recordDeed(ctx, { summary: `포로 ${name}을(를) 윽박질러 심문했다`, tags: ["cruelty"], severity: 1, privacy: "semi_private", noisy: false });
        store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: -2, affection: -1, respect: 0 }, reason: "심문" });
      }
      if (r.outcome !== "miss") {
        // 그 사람이 아는 것 중 주인공이 모르는 것 (코드가 고른다, 원칙 2·4)
        const known = new Set((state.beliefs[me.id] ?? []).map((b) => b.fact));
        const facts = (state.beliefs[t.id] ?? []).filter((b) => !known.has(b.fact)).sort((a, b) => (b.topic === "war" ? 1 : 0) - (a.topic === "war" ? 1 : 0));
        const take = facts.slice(0, r.outcome === "success" ? 2 : 1);
        for (const b of take) {
          store.append({
            type: "belief_added",
            characterId: me.id,
            belief: { id: `b_${store.getState().nextBeliefNo}`, fact: b.fact, source: "report", accuracy: r.outcome === "success" ? b.accuracy : "approximate", learnedAt: state.time, ...(b.topic ? { topic: b.topic } : {}) },
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
      store.append({ type: "npc_released", npcId: t.id });
      store.append({ type: "relation_changed", from: t.id, to: me.id, delta: { trust: 2, affection: 1, respect: 0 }, reason: "풀어 줌" });
      if (theirs && theirs !== me.factionId && state.factions[theirs]) {
        const now = disposition(content, theirs, me.factionId, state);
        if (now < 3) store.append({ type: "faction_disposition_changed", from: theirs, to: me.factionId, value: now + 1 });
      }
      const { deed } = recordDeed(ctx, { summary: `포로 ${name}을(를) 풀어 주었다`, tags: ["mercy"], severity: 1, privacy: "semi_private", noisy: false });
      lines.push(`${josa(name, "을/를")} 풀어 주었다. ${deed.summary}.`);
    } else if (input.action === "ransom") {
      if (!theirs || !state.factions[theirs] || theirs === me.factionId) return { ok: false, error: "몸값을 낼 무리가 없다." };
      if (disposition(content, theirs, me.factionId, state) <= -3) return { ok: false, error: "그 무리는 우리와 말도 섞지 않는다. 몸값도 맞교환도 없다." };
      // 그 무리에 갇힌 우리 사람이 있으면 맞바꾼다
      const ours = Object.values(state.characters).find((ch) => ch.captive?.by === theirs && ch.factionId === me.factionId && !ch.dead && ch.id !== me.id);
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
      const labor = !t.captive.labor;
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

export const CAPTIVITY_TOOLS = [takePrisoner, handlePrisoner, surrender] as const;

/** 끌고 온 포로를 우리 무리의 거점에 넘긴다 (지금 구역이 우리 무리의 거점일 때) */
export function deliverPrisoners(ctx: ToolContext): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me?.factionId || !zone || content.locations[zone]?.kind !== "base" || state.zones[zone]?.owner !== me.factionId) return [];
  const lines: string[] = [];
  for (const id of state.companions) {
    if (state.bonds[id]?.kind !== "prisoner") continue;
    store.append({ type: "npc_captured", npcId: id, by: me.factionId, zone });
    lines.push(`끌고 온 ${josa(playerCalls(state, content, id), "을/를")} 거점에 가뒀다. 이제 우리 무리의 포로다 (handle_prisoner).`);
  }
  return lines;
}
