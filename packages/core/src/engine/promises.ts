import { talkProblem } from "../rules/company.ts";
import { heldOf } from "../rules/held.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { hasMet, knowsName, playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import { equippedItem } from "./gear.ts";
import { recordDeed } from "./reputationTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";
import { ownedBy } from "../rules/home.ts";
import { itemSources } from "../content/sources.ts";
import { inZone, whereIs } from "../rules/place.ts";

/**
 * 약속 (기획서 8.11, 12-160·12-181). 주인공이 장면의 인물과 맺은 약속을 코드가 기억한다. 수치는 월드의 promises.
 * 약속은 두 길로 생긴다. 주인공이 먼저 하거나(make), 인물이 꺼낸 부탁을 받아 주거나(accept). 그 뒤는 같다.
 * - 부탁: 날이 바뀌면 asks.chance로, 만난 적 있는 인물 하나가 콘텐츠의 부탁(인물 YAML favors)을 품는다 (asked).
 *   GM 인물 카드에 보이고, 그 사람이 장면에 있으면 GM이 꺼낸다. expire_days 안에 답하지 않으면 접힌다 (lapsed)
 * - 지키기: 그 사람 앞에서. 물건 약속은 코드가 물건을 건넨다 (가진 만큼만). 다른 약속은 GM이 지켰다고 알린다.
 *   부탁이었으면 그 사람이 보답(물건·호감)을 건넨다
 * - 접기: 못 지키겠다고 털어놓는다 (덜 깎인다)
 * - 기한이 지나면 어긴 것이다. 신뢰가 깎이고, 그 사람이 아는 행적으로 남아 소문 길을 탄다
 */

export type PromiseRecord = GameState["promises"][number];
type AskContent = NonNullable<Content["npcs"][string]["favors"]>[number];

const rules = (content: Content) => content.scenario.promises;
const askContent = (content: Content, p: Pick<PromiseRecord, "to" | "favor">): AskContent | undefined =>
  p.favor ? content.npcs[p.to]?.favors?.find((x) => x.id === p.favor) : undefined;

/** 아직 지키지도 어기지도 않은 주인공의 약속 */
export function openPromises(state: GameState, to?: string): PromiseRecord[] {
  return (state.promises ?? []).filter((p) => p.by === state.playerId && p.status === "open" && (!to || p.to === to));
}

/** 인물이 품었고 아직 답하지 않은 부탁 */
export const askedPromises = (state: GameState, to?: string): PromiseRecord[] =>
  (state.promises ?? []).filter((p) => p.by === state.playerId && p.status === "asked" && (!to || p.to === to));

const describe = (content: Content, p: Pick<PromiseRecord, "what" | "item">) =>
  p.item ? `${p.what} (${content.items[p.item.id]?.name ?? p.item.id} ×${p.item.quantity})` : p.what;

/** 부탁 물건을 구할 만한 곳 한 토막 (12-239) */
const sourcesNote = (content: Content, item: { id: string } | null | undefined) => {
  const where = item ? itemSources(content, item.id) : [];
  return where.length ? ` · 구할 만한 곳: ${where.slice(0, 3).join(", ")}` : "";
};

/** 상태 화면·명령어의 한 줄 (12-174): 내가 한 약속인지, 받아 준 부탁인지 */
export type Pledge = { id: string; kind: "약속" | "부탁"; who: string; text: string; leftLabel: string; urgent: boolean };

export function pledges(state: GameState, content: Content, to?: string): Pledge[] {
  const today = dayOf(state.time);
  return openPromises(state, to).map((p) => {
    const left = p.due - today;
    return { id: p.id, kind: p.favor ? "부탁" : "약속", who: playerCalls(state, content, p.to), text: describe(content, p), leftLabel: left > 0 ? `${left}일 남음` : "오늘까지", urgent: left <= 0 };
  });
}

/** 인물 카드·?임무의 줄: 이 사람에게 한 약속(또는 받아 준 부탁)과 남은 날. 인물 카드(to)에는 아직 꺼내지 않은 부탁도 */
export function promiseLines(state: GameState, content: Content, to?: string): string[] {
  const open = pledges(state, content, to).map((p) => {
    const head = p.kind === "부탁" ? `${to ? "이 인물의 " : `${p.who}의 `}부탁 ${p.id} (들어주기로 했다)` : `${to ? "당신이 이 인물에게 한 " : `${p.who}에게 한 `}약속 ${p.id}`;
    const record = (state.promises ?? []).find((x) => x.id === p.id);
    return `${head}: ${p.text} — ${p.leftLabel}${record?.favor ? sourcesNote(content, record.item) : ""}`;
  });
  if (!to) return open;
  const asked = askedPromises(state, to).flatMap((p) => {
    const c = askContent(content, p);
    if (!c) return [];
    return [`이 인물이 꺼낼 부탁 ${p.id} (장면에서 자연스럽게 꺼낸다. 플레이어가 받으면 promise accept, 거절하면 decline. 그 물건을 transfer_item으로 바로 건네면 받아 주고 지킨 것이다): "${c.ask}" — ${describe(content, { what: "", item: c.item }).trim()}, ${c.days}일 안에${sourcesNote(content, c.item)}`];
  });
  return [...open, ...asked];
}

/** 말을 주고받을 수 있는가 (공통 규칙 8) */
const present = (state: GameState, content: Content, id: string): string | null => talkProblem(state, content, id, "한다");

const relate = (ctx: ToolContext, from: string, d: Partial<Record<"trust" | "affection" | "respect", number>>, reason: string) =>
  ctx.store.append({ type: "relation_changed", from, to: ctx.store.getState().playerId, delta: { trust: d.trust ?? 0, affection: d.affection ?? 0, respect: d.respect ?? 0 }, reason });

const QUIET: ToolDisplayEvent = { type: "time", activityLabel: "약속", durationLabel: "", fromLabel: "", toLabel: "" };
const nextId = (state: GameState) => `p_${(state.promises ?? []).length + 1}`;

const promiseTool = defineTool({
  name: "promise",
  description:
    "주인공과 장면의 인물 사이의 약속. make: 주인공이 약속한다 (what 한 줄, days 기한, 물건을 주기로 했으면 item). " +
    "accept·decline: 인물이 꺼낸 부탁(인물 카드의 '이 인물이 꺼낼 부탁 p_N')에 답한다. 받으면 그 물건·기한의 약속이 된다. " +
    "keep: 그 사람 앞에서 지킨다 (물건 약속은 시스템이 물건을 건넨다. transfer_item으로 건네도 된다. 다른 약속은 실제로 해낸 뒤에만 부른다). " +
    "fold: 못 지키겠다고 털어놓는다. 기한을 넘기면 시스템이 어긴 것으로 친다. 관계 변화와 보답은 시스템이 정한다. " +
    "플레이어가 분명히 약속했을 때만 make (지나가는 빈말은 아니다).",
  schema: z.strictObject({
    action: z.enum(["make", "accept", "decline", "keep", "fold"]),
    npc_id: z.string().nullable().default(null).describe("make: 약속을 받는 사람 (장면에 있어야 한다)"),
    what: z.string().max(120).nullable().default(null).describe("make: 약속 한 줄 (예: 사흘 안에 약을 구해 온다)"),
    days: z.number().int().min(1).max(30).nullable().default(null).describe("make: 며칠 안에"),
    item: z.strictObject({ id: z.string(), quantity: z.number().int().min(1) }).nullable().default(null).describe("make: 물건을 주기로 했으면 그 아이템과 수량"),
    promise_id: z.string().nullable().default(null).describe("accept·decline·keep·fold: 약속 id (인물 카드의 'p_N')"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    if (!r) return { ok: false, error: "이 월드에는 약속 규칙이 없다." };
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    const full = () => openPromises(state).length >= r.max_open;
    const fullError = { ok: false as const, error: `지키지 못한 약속이 이미 ${r.max_open}개다. 먼저 지키거나 접는다.` };
    if (input.action === "make") {
      if (!input.npc_id || !input.what?.trim() || !input.days) return { ok: false, error: "make에는 npc_id, what, days가 필요하다." };
      const bad = present(state, content, input.npc_id);
      if (bad) return { ok: false, error: bad };
      if (input.item && !content.items[input.item.id]) return { ok: false, error: `알 수 없는 아이템: ${input.item.id}` };
      if (full()) return fullError;
      const id = nextId(state);
      store.append({ type: "promise_made", id, by: me.id, to: input.npc_id, what: input.what.trim(), due: dayOf(state.time) + input.days, item: input.item ?? null, favor: null });
      const who = playerCalls(state, content, input.npc_id);
      return { ok: true, resultText: `${who}에게 약속했다 (${id}, ${input.days}일 안에). ${josa(who, "은/는")} 이 약속을 기억한다.`, display: QUIET, silent: true };
    }
    if (input.action === "accept" || input.action === "decline") {
      const p = askedPromises(state).find((x) => x.id === input.promise_id);
      if (!p) return { ok: false, error: `답할 수 있는 부탁이 아니다: ${input.promise_id ?? "(없음)"} (지금 꺼낼 부탁: ${askedPromises(state).map((x) => x.id).join(", ") || "없음"})` };
      // 같은 구역에 있으면 장면에서 막 나갔어도 받는다 (12-240, A7: 내보낸 직후 수락이 막혔다)
      const npc = content.npcs[p.to];
      const nearby = !!npc && inZone(state, content, p.to);
      const bad = nearby ? null : present(state, content, p.to);
      if (bad) return { ok: false, error: `부탁한 사람이 장면에 있어야 한다: ${bad} npc_presence로 다시 들인 뒤 답한다.` };
      const c = askContent(content, p);
      if (!c) return { ok: false, error: "알 수 없는 부탁이다." };
      const who = playerCalls(state, content, p.to);
      if (input.action === "decline") {
        store.append({ type: "promise_settled", id: p.id, status: "declined" });
        return { ok: true, resultText: `${who}의 부탁을 거절했다. 관계는 그대로다. 이 결과대로 서술하라.`, display: QUIET };
      }
      if (full()) return fullError;
      store.append({ type: "promise_accepted", id: p.id, what: c.ask, due: dayOf(state.time) + c.days, item: { id: c.item.id, quantity: c.item.quantity } });
      return {
        ok: true,
        resultText: `${who}의 부탁을 받았다 (약속 ${p.id}, ${c.days}일 안에 ${content.items[c.item.id]?.name ?? c.item.id} ×${c.item.quantity}). 물건을 구해 그 사람에게 건네면 지킨 것이다 (promise keep 또는 transfer_item). 이 결과대로 서술하라.`,
        display: QUIET,
      };
    }
    const p = (state.promises ?? []).find((x) => x.id === input.promise_id && x.by === me.id);
    if (!p || p.status !== "open") return { ok: false, error: `지킬 수 있는 약속이 아니다: ${input.promise_id ?? "(없음)"} (열린 약속: ${openPromises(state).map((x) => x.id).join(", ") || "없음"})` };
    const who = playerCalls(state, content, p.to);
    if (input.action === "fold") {
      store.append({ type: "promise_settled", id: p.id, status: "folded" });
      relate(ctx, p.to, r.folded, "못 지키겠다고 털어놓은 약속");
      return { ok: true, resultText: `${who}에게 약속을 못 지키겠다고 털어놓았다. 실망했지만 숨기지 않은 것은 안다. 이 결과대로 서술하라.`, display: QUIET };
    }
    const bad = present(state, content, p.to);
    if (bad) return { ok: false, error: `약속은 그 사람 앞에서 지킨다: ${bad}` };
    if (p.item) {
      const worn = (["weapon", "body", "head", "arms", "outer"] as const).filter((s) => equippedItem(me, s) === p.item!.id).length;
      if ((me.inventory[p.item.id] ?? 0) - worn < p.item.quantity) {
        return { ok: false, error: `${josa(content.items[p.item.id]?.name ?? p.item.id, "이/가")} ${p.item.quantity}개 있어야 한다 (걸친 것은 먼저 벗는다).` };
      }
      store.append({ type: "item_transferred", from: me.id, to: p.to, itemId: p.item.id, quantity: p.item.quantity });
    }
    return { ok: true, resultText: settleKept(ctx, p).join("\n"), display: QUIET };
  },
});

/** 약속을 지킨 것으로 매듭짓는다 (물건은 이미 건넸다). 부탁이었으면 보답. GM에게 줄 줄 */
function settleKept(ctx: ToolContext, p: PromiseRecord): string[] {
  const { store, content } = ctx;
  const r = rules(content)!;
  const state = store.getState();
  const who = playerCalls(state, content, p.to);
  store.append({ type: "promise_settled", id: p.id, status: "kept" });
  relate(ctx, p.to, r.kept, "지킨 약속");
  recordDeed(ctx, { summary: `${who}에게 한 약속을 지켰다: ${promiseGist(ctx.content, p)}`, tags: ["honesty"], severity: 1, privacy: "private", noisy: false }, { npcId: p.to, source: "seen" });
  const lines = [`${who}에게 한 약속을 지켰다${p.item ? " (물건을 건넸다)" : ""}. 이 결과대로 서술하라.`];
  const c = askContent(content, p);
  if (!c) return lines;
  if (c.reward.affection) store.append({ type: "relation_changed", from: p.to, to: state.playerId, delta: { trust: 0, affection: c.reward.affection, respect: 0 }, reason: "들어준 부탁" });
  if (c.reward.item) {
    store.append({ type: "item_granted", to: state.playerId, itemId: c.reward.item.id, quantity: c.reward.item.quantity });
    lines.push(`${josa(who, "이/가")} 고맙다며 ${content.items[c.reward.item.id]?.name ?? c.reward.item.id} ×${josa(String(c.reward.item.quantity), "을/를")} 건넨다.`);
  } else lines.push(`${josa(who, "은/는")} 이 일을 잊지 않을 것이다.`);
  return lines;
}

/** 약속한 물건을 transfer_item으로 그 사람에게 건넸으면 그대로 지킨 것이다 (promise keep을 따로 부르지 않아도) */
export function keepByGift(ctx: ToolContext, to: string, itemId: string, quantity: number): string[] {
  if (!rules(ctx.content)) return [];
  const state = ctx.store.getState();
  const p = openPromises(state).find((x) => x.to === to && x.item?.id === itemId && x.item.quantity <= quantity);
  if (p) return settleKept(ctx, p);
  // 아직 받는다고 답하지 않은 부탁이라도, 그 물건을 건넸으면 받아 주고 지킨 것이다 (12-265, PT18 분대장: 탄 한 발을 건넸는데 부탁이 그대로 남았다)
  const asked = askedPromises(state, to).find((x) => {
    const c = askContent(ctx.content, x);
    return !!c && c.item.id === itemId && c.item.quantity <= quantity;
  });
  const c = asked ? askContent(ctx.content, asked) : undefined;
  if (!asked || !c) return [];
  ctx.store.append({ type: "promise_accepted", id: asked.id, what: c.ask, due: dayOf(state.time) + c.days, item: { id: c.item.id, quantity: c.item.quantity } });
  const now = openPromises(ctx.store.getState()).find((x) => x.id === asked.id);
  return now ? settleKept(ctx, now) : [];
}

export const PROMISE_TOOLS = [promiseTool] as const;

/**
 * 하루가 지나면: 기한(그날 끝)을 넘긴 약속은 어긴 것이다. 그 사람의 신뢰가 깎이고 행적으로 남는다.
 * 꺼내지 못한 부탁은 접고, asks.chance로 새 부탁 하나를 품게 한다
 */
export function runPromisesDaily(ctx: ToolContext): string[] {
  const r = rules(ctx.content);
  if (!r) return [];
  const lines = runBrokenPromises(ctx);
  runAsksDaily(ctx);
  return lines;
}

export function runBrokenPromises(ctx: ToolContext): string[] {
  const r = rules(ctx.content)!;
  const state = ctx.store.getState();
  const today = dayOf(state.time);
  const lines: string[] = [];
  for (const p of openPromises(state)) {
    if (p.due >= today) continue;
    ctx.store.append({ type: "promise_settled", id: p.id, status: "broken" });
    const target = state.characters[p.to];
    if (!target || target.dead) continue;
    relate(ctx, p.to, r.broken, "어긴 약속");
    const who = playerCalls(state, ctx.content, p.to);
    recordDeed(ctx, { summary: `${who}에게 한 약속을 어겼다: ${promiseGist(ctx.content, p)}`, tags: ["deceit"], severity: 1, privacy: "private", noisy: false }, { npcId: p.to, source: "seen" });
    const line = `${who}에게 한 약속(${p.what})의 기한이 지났다. 지키지 못했다`;
    const now = ctx.store.getState();
    ctx.store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact: `${line}.`, source: "seen", accuracy: "exact", learnedAt: now.time } });
    lines.push(`${line}.`);
  }
  return lines;
}

/** 오래된 부탁을 접고, chance로 새 부탁 하나 (만난 적 있는 살아 있는 인물 중 아직 꺼내지 않은 부탁이 있는 한 사람) */
export function runAsksDaily(ctx: ToolContext): void {
  const { store, content, rng } = ctx;
  const r = rules(content)?.asks;
  if (!r) return;
  let state = store.getState();
  const me = state.playerId;
  const today = dayOf(state.time);
  for (const p of askedPromises(state)) {
    const npc = state.characters[p.to];
    if (!npc || npc.dead || today >= p.due) store.append({ type: "promise_settled", id: p.id, status: "lapsed" });
  }
  state = store.getState();
  const fromAsks = (state.promises ?? []).filter((p) => p.favor && (p.status === "asked" || p.status === "open"));
  if (fromAsks.length >= r.max_open || rng() >= r.chance) return;
  const asked = new Set((state.promises ?? []).filter((p) => p.favor).map((p) => `${p.to}|${p.favor}`));
  const candidates = Object.values(content.npcs)
    .filter((n) => (n.favors ?? []).length > 0)
    .filter((n) => {
      const c = state.characters[n.id];
      if (!c || c.dead || heldOf(c) || n.id === me || !(hasMet(state, me, n.id) || knowsName(state, me, n.id))) return false;
      // 주인공이 다시 마주칠 만한 사람만: 지금 구역, 내 거처, 우리 거점에 있는 사람 (12-195)
      const where = whereIs(state, content, n.id)?.zone;
      const myBase = Object.values(content.locations).find((l) => l.kind === "base" && !!state.characters[me]?.factionId && ownedBy(state, l.id, state.characters[me]?.factionId))?.id;
      if (!where || ![state.playerZone, state.homes?.[me], myBase].includes(where)) return false;
      if ((state.relations[n.id]?.[me]?.trust ?? 0) < -2) return false;
      return !fromAsks.some((p) => p.to === n.id);
    })
    .flatMap((n) => (n.favors ?? []).filter((x) => !asked.has(`${n.id}|${x.id}`) && (state.characters[n.id]?.inventory[x.item.id] ?? 0) < x.item.quantity).map((x) => ({ npc: n.id, ask: x })))
    // 이미 가진 물건은 부탁하지 않는다 (C10, 플레이 테스트 10: 무전기를 가진 사람이 무전기를 부탁했다)
    .sort((a, b) => `${a.npc}|${a.ask.id}`.localeCompare(`${b.npc}|${b.ask.id}`));
  if (!candidates.length) return;
  const pick = candidates[Math.floor(rng() * candidates.length)]!;
  store.append({ type: "promise_asked", id: nextId(state), by: me, to: pick.npc, what: pick.ask.ask, due: today + r.expire_days, item: { id: pick.ask.item.id, quantity: pick.ask.item.quantity }, favor: pick.ask.id });
}

/** 행적·소문에 남는 약속의 줄거리: 부탁 대사 원문이 아니라 물건으로 (플레이 테스트 11: 비밀 부탁의 대사가 소문으로 퍼졌다) */
function promiseGist(content: Content, p: { what: string; item?: { id: string; quantity: number } | null }): string {
  if (!p.item) return p.what;
  return `${content.items[p.item.id]?.name ?? p.item.id} ${p.item.quantity}개를 구해 주기로 한 약속`;
}
