import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { isCreature } from "../game/kinds.ts";
import { NEUTRAL_RELATION, type Deed, type DeedTag } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { TIE_LABELS, tiesOf } from "../game/ties.ts";
import { dayOf } from "../rules/time.ts";
import { moveOf } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { isIncapacitated } from "./body.ts";
import { rollPlayerCheck } from "./checks.ts";
import { valuesOf } from "./extras.ts";
import { equippedItem } from "./gear.ts";
import { marketValue } from "./market.ts";
import { profileOf } from "./people.ts";
import { learn, recordDeed } from "./reputationTools.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 뇌물·협박·폭로 (기획서 8.10, 12-153). 수치와 행동은 월드의 leverage.
 * - 뇌물: 물건을 주고 부탁을 산다. 받으면 그 사람의 약점이 된다 (주인공만 안다)
 * - 협박: 주인공이 아는 그 사람의 약점(털어놓은 비밀, 드러난 숨은 관계, 받은 뇌물)을 쥐고 요구한다
 * - 폭로: 그 약점을 장면 사람들에게 털어놓는다. 사실이라 판정이 없고, 그 사람의 행적으로 퍼진다. 폭로한 약점은 다시 쓸 수 없다
 * 부탁·요구를 실제로 들어주는 장면은 GM이 연출한다 (코드는 받아들였는지만 정한다)
 */

/** label: GM 카드의 줄. deed: 폭로했을 때 그 사람의 행적으로 퍼지는 한 줄 (그 사람이 한 일로) */
export type Leverage = { key: string; label: string; deed: string; tags: DeedTag[] };

const short = (text: string, n = 80) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** 주인공이 쥔 그 사람의 약점 (폭로한 것은 빼고) */
export function leveragesOn(state: GameState, content: Content, npcId: string): Leverage[] {
  const me = state.playerId;
  const out: Leverage[] = [];
  const secret = profileOf(state, content, npcId)?.secret;
  if (secret && state.revealedSecrets.includes(npcId)) out.push({ key: "secret", label: `털어놓은 비밀: ${short(secret.content)}`, deed: `숨겨 온 일이 드러났다: ${short(secret.content)}`, tags: ["deceit"] });
  for (const tie of tiesOf(state, content, npcId)) {
    if (!tie.secret || !(state.revealedTies ?? []).includes(tie.key)) continue;
    const enemySide = state.characters[tie.other]?.factionId !== state.characters[npcId]?.factionId;
    const tieText = `${playerCalls(state, content, tie.other)}의 ${TIE_LABELS[tie.kind]}${enemySide ? " (다른 무리)" : ""}`;
    out.push({ key: `tie:${tie.key}`, label: `숨은 관계: ${tieText}`, deed: `숨겨 온 관계가 드러났다: ${tieText}`, tags: enemySide ? ["enemy_sympathy"] : ["deceit"] });
  }
  state.bribes.forEach((b, i) => {
    if (b.npcId === npcId && b.by === me) out.push({ key: `bribe:${i}`, label: `뇌물을 받고 들어준 일: ${short(b.favor, 60)}`, deed: `뇌물을 받고 부탁을 들어주었다 ("${short(b.favor, 60)}")`, tags: ["selfishness"] });
  });
  return out.filter((l) => !state.exposed.includes(`${me}|${npcId}:${l.key}`));
}

/** GM 카드의 줄: 쥔 약점과 협박당한 사이 */
export function leverageLines(state: GameState, content: Content, npcId: string): string[] {
  const lines: string[] = [];
  const held = leveragesOn(state, content, npcId);
  if (held.length) lines.push(`당신이 쥔 이 인물의 약점 (blackmail의 leverage): ${held.map((l) => `${l.key} — ${l.label}`).join(" / ")}`);
  const b = state.blackmails.find((x) => x.npcId === npcId && x.by === state.playerId);
  if (b) lines.push(`[GM 전용] 당신에게 약점을 잡혀 있다${b.grudge ? ". 속으로 되갚을 날을 기다린다" : ""} (겉으로 드러낼지는 성격대로)`);
  const bribed = state.bribes.filter((x) => x.npcId === npcId && x.by === state.playerId).slice(-1)[0];
  if (bribed) lines.push(`당신에게 뇌물을 받고 들어주기로 한 일: ${short(bribed.favor, 60)}`);
  return lines;
}

function present(state: GameState, content: Content, id: string): string | null {
  const c = state.characters[id];
  if (!c || c.dead || id === state.playerId || !state.scene.present.includes(id)) return "그 사람이 장면에 없다.";
  if (isCreature(content, c)) return "사람에게만 쓴다.";
  if (isIncapacitated(content, c)) return "그 사람은 지금 대답할 수 없는 상태다.";
  return null;
}

const relate = (ctx: ToolContext, from: string, d: Partial<Record<"trust" | "affection" | "respect", number>>, reason: string) =>
  ctx.store.append({ type: "relation_changed", from, to: ctx.store.getState().playerId, delta: { trust: d.trust ?? 0, affection: d.affection ?? 0, respect: d.respect ?? 0 }, reason });

/** 뇌물의 값: 계급별 값 × 욕심 × 믿음 (가치관이 없으면 0으로 본다) */
export function bribePrice(content: Content, state: GameState, npcId: string): number | null {
  const rules = content.scenario.leverage?.bribe;
  const c = state.characters[npcId];
  if (!rules || !c) return null;
  const values = valuesOf(content, state, npcId);
  const greed = values[rules.greed] ?? 0;
  const base = rules.prices[c.rank] ?? rules.prices.default ?? 5;
  const trust = (state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
  return Math.max(1, Math.round(base * Math.max(0.2, 1 - rules.greed_step * greed) * (trust >= 2 ? rules.trusted : 1)));
}

const bribeTool = defineTool({
  name: "bribe",
  description:
    "장면의 인물에게 물건을 주고 부탁을 산다 (뇌물: 눈감아 주기, 문 열어 주기, 말해 주기). give는 내주는 물건, favor는 부탁 한 줄. " +
    "받는지는 시스템이 정한다: 값(계급·욕심·믿음)에 넉넉하면 받고, 조금 모자라면 판정, 턱없으면 거절. 원칙을 지키는 사람은 값과 상관없이 거절하고 기억한다. " +
    "받으면 그 일은 그 사람의 약점이 된다 (나중에 blackmail의 재료). 부탁을 들어주는 장면은 GM이 연출한다. 값을 지어내지 않는다.",
  schema: z.strictObject({
    npc_id: z.string(),
    give: z.record(z.string(), z.number().int().min(1)).describe("내주는 것: 아이템 id → 수량"),
    favor: z.string().min(1).max(120).describe("부탁 한 줄 (예: 오늘 밤 창고 뒷문을 잠그지 않는다)"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const rules = content.scenario.leverage?.bribe;
    if (!rules) return { ok: false, error: "이 월드에는 뇌물 규칙이 없다." };
    const bad = present(state, content, input.npc_id);
    if (bad) return { ok: false, error: bad };
    const me = state.characters[state.playerId]!;
    const who = playerCalls(state, content, input.npc_id);
    if (!Object.keys(input.give).length) return { ok: false, error: "내밀 물건이 없다." };
    for (const [id, n] of Object.entries(input.give)) {
      const worn = (["weapon", "body", "head", "arms", "outer"] as const).filter((s) => equippedItem(me, s) === id).length;
      if (!content.items[id]) return { ok: false, error: `알 수 없는 아이템: ${id}` };
      if ((me.inventory[id] ?? 0) - worn < n) return { ok: false, error: `${josa(content.items[id]!.name, "이/가")} 모자라다 (걸친 것은 먼저 벗는다).` };
    }
    const values = valuesOf(content, state, input.npc_id);
    // 원칙을 지키는 사람: 값과 상관없이 거절하고 기억한다
    if ((values[rules.scruple] ?? 0) >= rules.refuse_at && (values[rules.greed] ?? 0) <= 0) {
      relate(ctx, input.npc_id, { trust: -2 }, "뇌물을 내밀었다");
      recordDeed(ctx, { summary: `${who}에게 뇌물을 내밀었다`, tags: ["deceit"], severity: 1, privacy: "private", noisy: false }, { npcId: input.npc_id, source: "seen" });
      return { ok: true, resultText: `${josa(who, "은/는")} 물건을 쳐다보지도 않는다. 거절했고, 이 일을 기억한다 (신뢰가 떨어졌다). 이 결과대로 서술하라.`, display: { type: "time", activityLabel: "뇌물", durationLabel: "", fromLabel: "", toLabel: "" }, silent: true };
    }
    const price = bribePrice(content, state, input.npc_id)!;
    const offered = marketValue(content, state, input.give);
    let accepted = offered >= price;
    let checkLine = "";
    let display: ToolDisplayEvent = { type: "time", activityLabel: "뇌물", durationLabel: "", fromLabel: "", toLabel: "" };
    if (!accepted && offered * 2 >= price) {
      const m = moveOf(content.scenario, rules.move)!;
      const check = rollPlayerCheck({ move: rules.move, stat: m.stats[0]!, difficulty: "normal", intent: `${who}에게 뇌물을 내밀며 부탁한다` }, ctx, { target: input.npc_id });
      if (!check.ok) return check;
      accepted = check.outcome !== "miss";
      checkLine = `판정 ${check.checkId}: ${check.display.outcomeLabel}. `;
      display = check.display;
    }
    if (!accepted) {
      if (offered * 2 < price) relate(ctx, input.npc_id, { respect: -1 }, "턱없는 뇌물");
      return {
        ok: true,
        resultText: `${checkLine}${josa(who, "은/는")} 받지 않는다${offered * 2 < price ? " (턱없이 모자라 업신여긴다)" : ""}. 물건은 그대로 당신에게 있다. 이 결과대로 서술하라.`,
        display,
      };
    }
    for (const [id, n] of Object.entries(input.give)) store.append({ type: "item_transferred", from: me.id, to: input.npc_id, itemId: id, quantity: n });
    store.append({ type: "bribe_taken", npcId: input.npc_id, by: me.id, favor: input.favor });
    return {
      ok: true,
      resultText:
        `${checkLine}${josa(who, "이/가")} 받았다 (${Object.entries(input.give).map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ")}). ` +
        `부탁("${input.favor}")을 들어준다: 그 장면을 연출하라. 이 일은 이제 ${who}의 약점이다 (당신만 안다).`,
      display,
    };
  },
});

/** 같은 사람을 하루에 한 번만 다그친다 */
const DEMAND_EVERY_DAYS = 1;

const blackmailTool = defineTool({
  name: "blackmail",
  description:
    "주인공이 쥔 약점으로 그 사람을 협박하거나(demand) 그 약점을 장면 사람들에게 폭로한다(expose). leverage는 GM 카드의 '당신이 쥔 이 인물의 약점'에 나온 키. " +
    "약점이 없으면 쓸 수 없다 (지어낸 약점은 spread_rumor). demand: 그 사람이 장면에 있어야 하고 판정은 시스템이 굴린다. 들어주면 요구를 들어주는 장면을 연출한다. " +
    "expose: 들을 사람이 장면에 있어야 한다 (사실이라 판정 없음). 그 약점은 그 사람의 행적으로 퍼지고 다시 쓸 수 없다.",
  schema: z.strictObject({
    npc_id: z.string(),
    action: z.enum(["demand", "expose"]),
    leverage: z.string().describe("약점 키 (예: secret, tie:a|b, bribe:0)"),
    demand: z.string().max(120).nullable().default(null).describe("demand일 때 요구 한 줄. expose면 null"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const rules = content.scenario.leverage?.blackmail;
    if (!rules) return { ok: false, error: "이 월드에는 협박 규칙이 없다." };
    const target = state.characters[input.npc_id];
    if (!target || target.dead || isCreature(content, target)) return { ok: false, error: `알 수 없는 인물: ${input.npc_id}` };
    const lev = leveragesOn(state, content, input.npc_id).find((l) => l.key === input.leverage);
    if (!lev) return { ok: false, error: "그 사람에 대해 쥔 약점이 아니다. GM 카드의 '당신이 쥔 이 인물의 약점'에 있는 키만 쓴다." };
    const who = playerCalls(state, content, input.npc_id);
    const me = state.playerId;

    if (input.action === "expose") {
      const listeners = state.scene.present.filter((id) => id !== input.npc_id && !isCreature(content, state.characters[id]) && !state.characters[id]?.dead);
      if (!listeners.length) return { ok: false, error: "들을 사람이 없다." };
      const deed: Deed = {
        id: `d_${state.nextDeedNo}`,
        actorId: input.npc_id,
        summary: lev.deed,
        tags: lev.tags,
        severity: 2,
        at: state.time,
        witnesses: [],
        searched: false,
      };
      store.append({ type: "deed_recorded", deed });
      for (const id of listeners) learn(ctx, deed, id, "report");
      store.append({ type: "leverage_exposed", by: me, key: `${input.npc_id}:${lev.key}` });
      // 그 자리에 있었다면 바로 안다
      if (state.scene.present.includes(input.npc_id)) relate(ctx, input.npc_id, { trust: -3, affection: -3 }, "약점을 폭로당했다");
      return {
        ok: true,
        resultText: `${listeners.map((id) => playerCalls(state, content, id)).join(", ")}에게 ${who}의 약점을 털어놓았다: ${lev.label}. 이 말은 ${who}의 일로 퍼진다 (무리 안의 믿음에 닿는다). 이 약점은 이제 쥘 수 없다.`,
        display: { type: "time", activityLabel: "폭로", durationLabel: "", fromLabel: "", toLabel: "" },
        silent: true,
      };
    }

    const bad = present(state, content, input.npc_id);
    if (bad) return { ok: false, error: bad };
    if (!input.demand) return { ok: false, error: "무엇을 요구하는지 demand에 적는다." };
    const last = state.blackmails.find((b) => b.npcId === input.npc_id && b.by === me);
    if (last && dayOf(state.time) - dayOf(last.at) < DEMAND_EVERY_DAYS) return { ok: false, error: `${josa(who, "은/는")} 오늘 이미 다그쳤다.` };
    const m = moveOf(content.scenario, rules.move)!;
    const check = rollPlayerCheck({ move: rules.move, stat: m.stats[0]!, difficulty: "normal", intent: `${who}의 약점을 쥐고 요구한다` }, ctx, { target: input.npc_id });
    if (!check.ok) return check;
    let text: string;
    if (check.outcome === "success") {
      relate(ctx, input.npc_id, { trust: -2, affection: -2 }, "협박당했다");
      store.append({ type: "blackmailed", npcId: input.npc_id, by: me, leverage: lev.key, grudge: false });
      text = `${josa(who, "은/는")} 요구("${input.demand}")를 들어준다. 그 장면을 연출하라. 이제 당신에게 약점을 잡혀 있다.`;
    } else if (check.outcome === "partial") {
      relate(ctx, input.npc_id, { trust: -2, affection: -3 }, "협박당했다");
      store.append({ type: "blackmailed", npcId: input.npc_id, by: me, leverage: lev.key, grudge: true });
      text = `${josa(who, "은/는")} 요구("${input.demand}")를 들어준다. 다만 눈빛이 달라졌다: 되갚을 날을 기다린다 (드러내지 않는다).`;
    } else {
      relate(ctx, input.npc_id, { trust: -2 }, "협박하려 했다");
      recordDeed(ctx, { summary: `${who}의 약점을 쥐고 협박했다`, tags: ["cruelty"], severity: 2, privacy: "private", noisy: false }, { npcId: input.npc_id, source: "seen" });
      text = `${josa(who, "은/는")} 물러서지 않는다 ("해 보라지"). 요구는 거절당했고, 당신이 협박한 일을 기억한다. 약점은 아직 쥐고 있다 (폭로할 수 있다).`;
    }
    return { ok: true, resultText: `협박 판정 ${check.checkId}: ${check.display.outcomeLabel}. ${text} 이 결과대로 서술하라.` + (check.growthNote ? `\n${check.growthNote}` : ""), display: check.display };
  },
});

export const LEVERAGE_TOOLS = [bribeTool, blackmailTool] as const;
