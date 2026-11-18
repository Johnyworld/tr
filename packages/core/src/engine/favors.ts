import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { hasMet, knowsName, playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { josa } from "../text.ts";
import { isIncapacitated } from "./body.ts";
import { openPromises } from "./promises.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 부탁 (기획서 8.11.1, 12-174). 이름 있는 인물이 주인공에게 사적인 물건 부탁을 한다. 받으면 약속(8.11)이 된다.
 * - 품기: 날이 바뀌면 chance로, 주인공이 만난 적 있는 살아 있는 인물 중 아직 꺼내지 않은 부탁이 있는 한 사람이 품는다
 * - 꺼내기: GM 인물 카드에 보인다. 그 사람이 장면에 있으면 GM이 꺼낸다. expire_days 안에 못 꺼내면 접는다
 * - favor 도구: accept면 물건·기한으로 약속을 맺는다, decline이면 접는다 (관계는 그대로)
 * - 약속을 지키면 promises.ts가 settleFavor로 보답(물건·호감)을 건넨다. 어기면 약속을 어긴 것과 같다
 */

export type FavorRecord = GameState["favors"][number];
type FavorContent = NonNullable<Content["npcs"][string]["favors"]>[number];

const rules = (content: Content) => content.scenario.favors;
export const favorContent = (content: Content, f: Pick<FavorRecord, "npc" | "favor">): FavorContent | undefined => content.npcs[f.npc]?.favors?.find((x) => x.id === f.favor);

/** 아직 받지도 접지도 않은 부탁 */
export const offeredFavors = (state: GameState, npc?: string) => (state.favors ?? []).filter((f) => f.status === "offered" && (!npc || f.npc === npc));

/** 인물 카드의 줄 */
export function favorLines(state: GameState, content: Content, npc: string): string[] {
  return offeredFavors(state, npc).map((f) => {
    const c = favorContent(content, f);
    if (!c) return "";
    const item = `${content.items[c.item.id]?.name ?? c.item.id} ×${c.item.quantity}`;
    return `이 인물이 꺼낼 부탁 ${f.id} (장면에서 자연스럽게 꺼낸다. 플레이어가 받거나 거절하면 favor): "${c.ask}" — ${item}, ${c.days}일 안에`;
  }).filter(Boolean);
}

/** 하루가 지나면: 오래된 부탁을 접고, chance로 새 부탁 하나 */
export function runFavorsDaily(ctx: ToolContext): void {
  const { store, content, rng } = ctx;
  const r = rules(content);
  if (!r) return;
  let state = store.getState();
  const me = state.playerId;
  for (const f of offeredFavors(state)) {
    const npc = state.characters[f.npc];
    if (!npc || npc.dead || state.time - f.offeredAt >= r.expire_days * MINUTES_PER_DAY) store.append({ type: "favor_settled", id: f.id, status: "lapsed" });
  }
  state = store.getState();
  const busy = offeredFavors(state).length + (state.favors ?? []).filter((f) => f.status === "accepted").length;
  if (busy >= r.max_open || rng() >= r.chance) return;
  const asked = new Set((state.favors ?? []).map((f) => `${f.npc}|${f.favor}`));
  const candidates = Object.values(content.npcs)
    .filter((n) => (n.favors ?? []).length > 0)
    .filter((n) => {
      const c = state.characters[n.id];
      if (!c || c.dead || c.captive || n.id === me || !(hasMet(state, me, n.id) || knowsName(state, me, n.id))) return false;
      if ((state.relations[n.id]?.[me]?.trust ?? 0) < -1) return false;
      return !offeredFavors(state, n.id).length && !(state.favors ?? []).some((f) => f.npc === n.id && f.status === "accepted");
    })
    .flatMap((n) => (n.favors ?? []).filter((x) => !asked.has(`${n.id}|${x.id}`)).map((x) => ({ npc: n.id, favor: x.id })))
    .sort((a, b) => `${a.npc}|${a.favor}`.localeCompare(`${b.npc}|${b.favor}`));
  if (!candidates.length) return;
  const pick = candidates[Math.floor(rng() * candidates.length)]!;
  store.append({ type: "favor_offered", id: `f_${(state.favors ?? []).length + 1}`, npc: pick.npc, favor: pick.favor });
}

/** 부탁에서 맺은 약속이 끝났다: 지키면 보답, 어기면 기록만 */
export function settleFavor(ctx: ToolContext, favorId: string, kept: boolean): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const f = (state.favors ?? []).find((x) => x.id === favorId);
  if (!f || f.status !== "accepted") return [];
  store.append({ type: "favor_settled", id: f.id, status: kept ? "kept" : "broken" });
  const c = favorContent(content, f);
  if (!kept || !c) return [];
  const who = playerCalls(state, content, f.npc);
  const lines: string[] = [];
  if (c.reward.affection) store.append({ type: "relation_changed", from: f.npc, to: state.playerId, delta: { trust: 0, affection: c.reward.affection, respect: 0 }, reason: "들어준 부탁" });
  if (c.reward.item) {
    store.append({ type: "item_granted", to: state.playerId, itemId: c.reward.item.id, quantity: c.reward.item.quantity });
    lines.push(`${josa(who, "이/가")} 고맙다며 ${content.items[c.reward.item.id]?.name ?? c.reward.item.id} ×${c.reward.item.quantity}을(를) 건넨다.`);
  } else lines.push(`${josa(who, "은/는")} 이 일을 잊지 않을 것이다.`);
  return lines;
}

const QUIET: ToolDisplayEvent = { type: "time", activityLabel: "부탁", durationLabel: "", fromLabel: "", toLabel: "" };

const favorTool = defineTool({
  name: "favor",
  description:
    "인물이 꺼낸 부탁(인물 카드의 '이 인물이 꺼낼 부탁 f_N')에 플레이어가 답한다. 그 사람이 장면에 있어야 한다. " +
    "accept: 받는다 (그 물건과 기한으로 약속이 맺어진다. 지킬 때는 promise keep). decline: 거절한다. 관계 변화와 보답은 시스템이 정한다.",
  schema: z.strictObject({ favor_id: z.string(), action: z.enum(["accept", "decline"]) }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const r = rules(content);
    const promiseRules = content.scenario.promises;
    if (!r || !promiseRules) return { ok: false, error: "이 월드에는 부탁 규칙이 없다." };
    const state = store.getState();
    const f = offeredFavors(state).find((x) => x.id === input.favor_id);
    if (!f) return { ok: false, error: `답할 수 있는 부탁이 아니다: ${input.favor_id} (지금 꺼낼 부탁: ${offeredFavors(state).map((x) => x.id).join(", ") || "없음"})` };
    const npc = state.characters[f.npc];
    if (!npc || npc.dead || !state.scene.present.includes(f.npc) || isIncapacitated(content, npc)) return { ok: false, error: "부탁한 사람이 장면에 있어야 한다." };
    const c = favorContent(content, f);
    if (!c) return { ok: false, error: "알 수 없는 부탁이다." };
    const who = playerCalls(state, content, f.npc);
    if (input.action === "decline") {
      store.append({ type: "favor_settled", id: f.id, status: "declined" });
      return { ok: true, resultText: `${who}의 부탁을 거절했다. 관계는 그대로다. 이 결과대로 서술하라.`, display: QUIET };
    }
    if (openPromises(state).length >= promiseRules.max_open) return { ok: false, error: `지키지 못한 약속이 이미 ${promiseRules.max_open}개다. 먼저 지키거나 접는다.` };
    const id = `p_${(state.promises ?? []).length + 1}`;
    store.append({ type: "favor_settled", id: f.id, status: "accepted" });
    store.append({ type: "promise_made", id, by: state.playerId, to: f.npc, what: c.ask, due: dayOf(state.time) + c.days, item: { id: c.item.id, quantity: c.item.quantity }, favor: f.id });
    return {
      ok: true,
      resultText: `${who}의 부탁을 받았다 (약속 ${id}, ${c.days}일 안에 ${content.items[c.item.id]?.name ?? c.item.id} ×${c.item.quantity}). 물건을 구해 그 사람 앞에서 promise keep. 이 결과대로 서술하라.`,
      display: QUIET,
    };
  },
});

export const FAVOR_TOOLS = [favorTool] as const;
