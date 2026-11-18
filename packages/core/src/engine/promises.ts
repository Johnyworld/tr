import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { isCreature } from "../game/kinds.ts";
import type { GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import { isIncapacitated } from "./body.ts";
import { equippedItem } from "./gear.ts";
import { recordDeed } from "./reputationTools.ts";
import { settleFavor } from "./favors.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 약속 (기획서 8.11, 12-160). 주인공이 장면의 인물에게 한 약속을 코드가 기억한다. 수치는 월드의 promises.
 * - 맺기: 무엇을, 며칠 안에. 물건을 주기로 했으면 그 물건과 수량을 적는다
 * - 지키기: 그 사람 앞에서. 물건 약속은 코드가 물건을 건넨다 (가진 만큼만). 다른 약속은 GM이 지켰다고 알린다
 * - 접기: 못 지키겠다고 털어놓는다 (덜 깎인다)
 * - 기한이 지나면 어긴 것이다. 신뢰가 깎이고, 그 사람이 아는 행적으로 남아 소문 길을 탄다
 */

export type PromiseRecord = GameState["promises"][number];

const rules = (content: Content) => content.scenario.promises;

/** 아직 지키지도 어기지도 않은 주인공의 약속 */
export function openPromises(state: GameState, to?: string): PromiseRecord[] {
  return (state.promises ?? []).filter((p) => p.by === state.playerId && p.status === "open" && (!to || p.to === to));
}

const describe = (content: Content, p: PromiseRecord) =>
  p.item ? `${p.what} (${content.items[p.item.id]?.name ?? p.item.id} ×${p.item.quantity})` : p.what;

/** 상태 화면·명령어의 한 줄 (12-174): 내가 한 약속인지, 받아 준 부탁인지 */
export type Pledge = { id: string; kind: "약속" | "부탁"; who: string; text: string; leftLabel: string; urgent: boolean };

export function pledges(state: GameState, content: Content, to?: string): Pledge[] {
  const today = dayOf(state.time);
  return openPromises(state, to).map((p) => {
    const left = p.due - today;
    return { id: p.id, kind: p.favor ? "부탁" : "약속", who: playerCalls(state, content, p.to), text: describe(content, p), leftLabel: left > 0 ? `${left}일 남음` : "오늘까지", urgent: left <= 0 };
  });
}

/** 인물 카드·?임무의 줄: 이 사람에게 한 약속(또는 받아 준 부탁)과 남은 날 */
export function promiseLines(state: GameState, content: Content, to?: string): string[] {
  return pledges(state, content, to).map((p) => {
    const head = p.kind === "부탁" ? `${to ? "이 인물의 " : `${p.who}의 `}부탁 ${p.id} (들어주기로 했다)` : `${to ? "당신이 이 인물에게 한 " : `${p.who}에게 한 `}약속 ${p.id}`;
    return `${head}: ${p.text} — ${p.leftLabel}`;
  });
}

function present(state: GameState, content: Content, id: string): string | null {
  const c = state.characters[id];
  if (!c || c.dead || id === state.playerId || !state.scene.present.includes(id)) return "그 사람이 장면에 없다.";
  if (isCreature(content, c)) return "사람에게만 한다.";
  if (isIncapacitated(content, c)) return "그 사람은 지금 대답할 수 없는 상태다.";
  return null;
}

const relate = (ctx: ToolContext, from: string, d: Partial<Record<"trust" | "affection" | "respect", number>>, reason: string) =>
  ctx.store.append({ type: "relation_changed", from, to: ctx.store.getState().playerId, delta: { trust: d.trust ?? 0, affection: d.affection ?? 0, respect: d.respect ?? 0 }, reason });

const QUIET: ToolDisplayEvent = { type: "time", activityLabel: "약속", durationLabel: "", fromLabel: "", toLabel: "" };

const promiseTool = defineTool({
  name: "promise",
  description:
    "주인공이 장면의 인물에게 한 약속을 기억시킨다. make: 약속을 맺는다 (what 한 줄, days 기한, 물건을 주기로 했으면 item). " +
    "keep: 그 사람 앞에서 지킨다 (물건 약속은 시스템이 물건을 건넨다. 다른 약속은 실제로 해낸 뒤에만 부른다). " +
    "fold: 못 지키겠다고 털어놓는다. 기한을 넘기면 시스템이 어긴 것으로 친다. 관계 변화는 시스템이 정한다. " +
    "플레이어가 분명히 약속했을 때만 make (지나가는 빈말은 아니다).",
  schema: z.strictObject({
    action: z.enum(["make", "keep", "fold"]),
    npc_id: z.string().nullable().default(null).describe("make: 약속을 받는 사람 (장면에 있어야 한다)"),
    what: z.string().max(120).nullable().default(null).describe("make: 약속 한 줄 (예: 사흘 안에 약을 구해 온다)"),
    days: z.number().int().min(1).max(30).nullable().default(null).describe("make: 며칠 안에"),
    item: z.strictObject({ id: z.string(), quantity: z.number().int().min(1) }).nullable().default(null).describe("make: 물건을 주기로 했으면 그 아이템과 수량"),
    promise_id: z.string().nullable().default(null).describe("keep·fold: 약속 id (인물 카드의 '약속 p_N')"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    if (!r) return { ok: false, error: "이 월드에는 약속 규칙이 없다." };
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    if (input.action === "make") {
      if (!input.npc_id || !input.what?.trim() || !input.days) return { ok: false, error: "make에는 npc_id, what, days가 필요하다." };
      const bad = present(state, content, input.npc_id);
      if (bad) return { ok: false, error: bad };
      if (input.item && !content.items[input.item.id]) return { ok: false, error: `알 수 없는 아이템: ${input.item.id}` };
      if (openPromises(state).length >= r.max_open) return { ok: false, error: `지키지 못한 약속이 이미 ${r.max_open}개다. 먼저 지키거나 접는다.` };
      const id = `p_${(state.promises ?? []).length + 1}`;
      const due = dayOf(state.time) + input.days;
      store.append({ type: "promise_made", id, by: me.id, to: input.npc_id, what: input.what.trim(), due, item: input.item ?? null, favor: null });
      const who = playerCalls(state, content, input.npc_id);
      return { ok: true, resultText: `${who}에게 약속했다 (${id}, ${input.days}일 안에). ${josa(who, "은/는")} 이 약속을 기억한다.`, display: QUIET, silent: true };
    }
    const p = (state.promises ?? []).find((x) => x.id === input.promise_id && x.by === me.id);
    if (!p || p.status !== "open") return { ok: false, error: `지킬 수 있는 약속이 아니다: ${input.promise_id ?? "(없음)"} (열린 약속: ${openPromises(state).map((x) => x.id).join(", ") || "없음"})` };
    const who = playerCalls(state, content, p.to);
    if (input.action === "fold") {
      store.append({ type: "promise_settled", id: p.id, status: "folded" });
      relate(ctx, p.to, r.folded, "못 지키겠다고 털어놓은 약속");
      if (p.favor) settleFavor(ctx, p.favor, false);
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

/** 약속을 지킨 것으로 매듭짓는다 (물건은 이미 건넸다). GM에게 줄 줄 */
function settleKept(ctx: ToolContext, p: PromiseRecord): string[] {
  const r = rules(ctx.content)!;
  const who = playerCalls(ctx.store.getState(), ctx.content, p.to);
  ctx.store.append({ type: "promise_settled", id: p.id, status: "kept" });
  relate(ctx, p.to, r.kept, "지킨 약속");
  recordDeed(ctx, { summary: `${who}에게 한 약속을 지켰다: ${p.what}`, tags: ["honesty"], severity: 1, privacy: "private", noisy: false }, { npcId: p.to, source: "seen" });
  // 부탁에서 맺은 약속이면 보답 (12-174)
  const thanks = p.favor ? settleFavor(ctx, p.favor, true) : [];
  return [`${who}에게 한 약속을 지켰다${p.item ? " (물건을 건넸다)" : ""}. 이 결과대로 서술하라.`, ...thanks];
}

/** 약속한 물건을 transfer_item으로 그 사람에게 건넸으면 그대로 지킨 것이다 (promise keep을 따로 부르지 않아도) */
export function keepByGift(ctx: ToolContext, to: string, itemId: string, quantity: number): string[] {
  if (!rules(ctx.content)) return [];
  const state = ctx.store.getState();
  const p = openPromises(state).find((x) => x.by === state.playerId && x.to === to && x.item?.id === itemId && x.item.quantity <= quantity);
  return p ? settleKept(ctx, p) : [];
}

export const PROMISE_TOOLS = [promiseTool] as const;

/** 하루가 지나면: 기한(그날 끝)을 넘긴 약속은 어긴 것이다. 그 사람의 신뢰가 깎이고 행적으로 남는다 */
export function runBrokenPromises(ctx: ToolContext): string[] {
  const r = rules(ctx.content);
  const state = ctx.store.getState();
  if (!r) return [];
  const today = dayOf(state.time);
  const lines: string[] = [];
  for (const p of openPromises(state)) {
    if (p.due >= today) continue;
    ctx.store.append({ type: "promise_settled", id: p.id, status: "broken" });
    if (p.favor) settleFavor(ctx, p.favor, false);
    const target = state.characters[p.to];
    if (!target || target.dead) continue;
    relate(ctx, p.to, r.broken, "어긴 약속");
    const who = playerCalls(state, ctx.content, p.to);
    recordDeed(ctx, { summary: `${who}에게 한 약속을 어겼다: ${p.what}`, tags: ["deceit"], severity: 1, privacy: "private", noisy: false }, { npcId: p.to, source: "seen" });
    const line = `${who}에게 한 약속(${p.what})의 기한이 지났다. 지키지 못했다`;
    const now = ctx.store.getState();
    ctx.store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact: `${line}.`, source: "seen", accuracy: "exact", learnedAt: now.time } });
    lines.push(`${line}.`);
  }
  return lines;
}
