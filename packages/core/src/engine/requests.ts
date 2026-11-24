import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { itemSources } from "../content/sources.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { isCreature } from "../game/kinds.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { talkProblem } from "../rules/company.ts";
import { hostileLand, ownedBy } from "../rules/home.ts";
import { currentPlace, inZone, keepingPlaceOf, knowsPlace, stepsBetween, placeById, placeHint, placesIn, whereIs } from "../rules/place.ts";
import { activeRequest, offeredQuests, questOf, questProgress, questTopic, type Quest, type QuestKind } from "../rules/request.ts";
import { dayOf } from "../rules/time.ts";
import { attemptValue, bestStatOf } from "../rules/skill.ts";
import { neighbors } from "../sim/war.ts";
import { josa } from "../text.ts";
import { captureNpc } from "./captivity.ts";
import { createExtraCharacter } from "./extras.ts";
import { abandonRequest, handOver, settleKept } from "./promises.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 의뢰 (12-291, docs/requests-plan.md): 이야기 사이 남는 시간을 채우는 반복 일거리. 보통의 RPG처럼 장면의 인물에게 일거리를 물으면
 * 코드가 그 사람이 줄 만한 의뢰를 하나 만든다 (원칙 2: 목표·기한·보수는 코드가 정하고 GM은 연출만).
 * - 종류: 찾아오기(근처 구역 수색에서 나오는 물건), 사람 찾기·붙잡아 오기·처치하기(받을 때 목표 엑스트라를 근처 구역의 한 장소에 둔다)
 * - 진행 중인 의뢰는 한 번에 하나 (인물이 먼저 꺼낸 부탁 favors를 받은 것도 센다, rules/request.ts). 임무와는 따로
 * - 목표가 어느 장소에 있는지는 의뢰인이 아는 만큼: 주인공이 아는 장소면 이름, 모르면 어림 단편(placeHint)
 * - 기한을 넘기면 promises.ts가 어긴 것으로 친다 (requests.failed). 수치는 시나리오의 requests
 */

type Requests = NonNullable<Content["scenario"]["requests"]>;
type Giver = Requests["givers"][number];

const QUIET: ToolDisplayEvent = { type: "time", activityLabel: "의뢰", durationLabel: "", fromLabel: "", toLabel: "" };
const between = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const nextId = (state: GameState) => `p_${(state.promises ?? []).length + 1}`;

/** 의뢰인 구역에서 길로 reach 구역 안 (거리와 함께). 적 땅은 뺀다 */
function zonesWithin(state: GameState, content: Content, from: string, reach: number): { zone: string; hops: number }[] {
  const seen = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const z = queue.shift()!;
    const d = seen.get(z)!;
    if (d >= reach) continue;
    for (const n of neighbors(content, z)) {
      if (seen.has(n) || (content.locations[n]?.isolated && content.locations[from]?.isolated !== true)) continue;
      seen.set(n, d + 1);
      queue.push(n);
    }
  }
  return [...seen].filter(([z]) => !hostileLand(state, content, z)).map(([zone, hops]) => ({ zone, hops }));
}

/** 이 사람이 줄 만한 의뢰 줄 (위에서부터 처음 맞는 것) */
function giverRule(state: GameState, content: Content, id: string): Giver | null {
  const r = content.scenario.requests;
  const c = state.characters[id];
  if (!r || !c) return null;
  const npc = content.npcs[id];
  return (
    r.givers.find((g) => {
      if (g.merchant && !npc?.merchant) return false;
      if (g.healer && !npc?.healer) return false;
      if (g.skills && !g.skills.some((m) => (c.skills[m] ?? -Infinity) >= g.min_skill)) return false;
      return true;
    }) ?? null
  );
}

/**
 * 목표를 둘 장소: 길·가두는 곳이 아니고, 구역에 들어선 길에서 두 칸 이상 안쪽 (12-293, PT24·25: 사람 찾기가 늘 어귀 첫 문이었다).
 * 주인공이 지금 서 있는 곳은 뺀다 (PT25 분대장: 목표가 서 있던 상가에 놓였다). 그런 곳이 없으면 가장 먼 곳
 */
function targetPlace(state: GameState, content: Content, zone: string, rng: Rng): string | null {
  const all = placesIn(state, content, zone).filter((p) => !p.spawned);
  const roads = all.filter((p) => p.road).map((p) => p.id);
  const inner = all.filter((p) => !p.road && !p.jail && !(zone === state.playerZone && p.id === currentPlace(state, content)?.id));
  if (!inner.length) return all.length ? pick(rng, all).id : null;
  const depth = (id: string) => (roads.length ? Math.min(...roads.map((r) => stepsBetween(state, content, r, id, zone))) : 0);
  const deep = inner.filter((p) => depth(p.id) >= 2);
  if (deep.length) return pick(rng, deep).id;
  const far = Math.max(...inner.map((p) => depth(p.id)));
  return pick(rng, inner.filter((p) => depth(p.id) === far)).id;
}

/** 의뢰 하나를 만든다 (아직 받지 않음: 목표 엑스트라는 받을 때 둔다) */
function makeOffer(state: GameState, content: Content, giverId: string, rng: Rng): { what: string; item: { id: string; quantity: number } | null; goal: Quest } | null {
  const r = content.scenario.requests!;
  const rule = giverRule(state, content, giverId);
  const from = whereIs(state, content, giverId)?.zone ?? state.playerZone;
  if (!rule || !from) return null;
  const near = zonesWithin(state, content, from, r.reach);
  // 사람·짐승을 두는 의뢰는 주인 없는 구역에만 (PT24 섬: 맞닿은 구역이 없어 목표가 우리 땅 식당, 의뢰인 바로 곁에 놓였다). 없으면 찾아오기만
  const wild = near.filter((z) => !state.zones[z.zone]?.owner);
  const me = state.characters[state.playerId];
  // 싸움 의뢰는 싸울 줄 아는 주인공에게만 (PT24 졸병·섬: 다섯 번 덤벼 한 번도 못 맞히고 치명상 셋)
  const canFight = !r.fight || r.fight.moves.some((m) => {
    const move = content.scenario.moves.find((x) => x.id === m);
    const skill = me ? attemptValue(content.scenario, me.skills, m) : null;
    return !!move && skill !== null && (me?.stats[bestStatOf(state, move)] ?? 0) + skill >= r.fight!.min;
  });
  // 처음 해 볼 종류를 굴리고, 목표를 둘 수 없으면 다음 종류로
  const start = Math.floor(rng() * rule.kinds.length);
  const kinds = [...rule.kinds.slice(start), ...rule.kinds.slice(0, start)];
  for (const kind of kinds) {
    if (kind === "fetch") {
      // 남의 땅을 뒤지는 일(도둑질)이 되지 않게 주인 없는 구역·의뢰인 무리 땅부터 (없으면 근처 어디든)
      const giverFaction = state.characters[giverId]?.factionId;
      // 수색표에서 흔한 것만(드문 것은 찾다 막힌다, PT24 분대장 모르핀), 이미 지닌 것은 빼고(받자마자 건네 끝났다, PT24 하얀매 붕대)
      const lootIn = (zs: typeof near) =>
        zs.flatMap((z) =>
          (content.locations[z.zone]?.loot?.items ?? [])
            .filter((i) => i.weight >= r.kinds.fetch.min_weight && (!rule.items || rule.items.includes(i.item)) && !(me?.inventory[i.item] ?? 0) && !stashed(state, i.item) && !(state.characters[giverId]?.inventory[i.item] ?? 0))
            .map((i) => ({ ...z, item: i.item })),
        );
      // 주인 없는 땅 먼저, 없으면 의뢰인 무리 땅(섬), 그래도 없으면 근처 어디든 (PT25 졸병: 우리 초소를 뒤지라는 찾아오기)
      const wildLoot = lootIn(near.filter((z) => !state.zones[z.zone]?.owner));
      const ownLoot = lootIn(near.filter((z) => ownedBy(state, z.zone, giverFaction)));
      const found = wildLoot.length ? wildLoot : ownLoot.length ? ownLoot : lootIn(near);
      if (!found.length) continue;
      const f = pick(rng, found);
      const qty = between(rng, r.kinds.fetch.quantity);
      return { what: `${content.items[f.item]?.name ?? f.item} ${qty}개를 구해 온다`, item: { id: f.item, quantity: qty }, goal: { kind, template: null, target: null, zone: f.zone, place: null, hops: f.hops, pay: payFor(content, kind, f.zone, f.hops, rng), delivered: 0, days: between(rng, r.days) + f.hops * r.per_hop_days } };
    }
    if (!wild.length || (kind !== "find" && !canFight)) continue;
    const templates = r.kinds[kind].templates.filter((t) => !!content.extras[t]);
    if (!templates.length) continue;
    const template = pick(rng, templates);
    const z = pick(rng, wild);
    const label = content.extras[template]!.label;
    const verb = kind === "find" ? "찾는다" : kind === "capture" ? "산 채로 붙잡아 묶어 온다" : "처치한다";
    return { what: `${josa(label, "을/를")} ${verb}`, item: null, goal: { kind, template, target: null, zone: z.zone, place: targetPlace(state, content, z.zone, rng), hops: z.hops, pay: payFor(content, kind, z.zone, z.hops, rng), delivered: 0, days: between(rng, r.days) + z.hops * r.per_hop_days } };
  }
  return null;
}

/** 주인공의 사물함·거처에 이미 있는가 (PT25 섬: 사물함의 토마토로 0분에 끝났다) */
function stashed(state: GameState, item: string): boolean {
  return Object.values(state.stashes?.[state.playerId] ?? {}).some((items) => (items[item] ?? 0) > 0);
}

function payFor(content: Content, kind: QuestKind, zone: string, hops: number, rng: Rng): Quest["pay"] {
  const w = content.scenario.requests!.reward;
  const total = w.pay.reduce((n, x) => n + x.weight, 0);
  let roll = rng() * total;
  const item = w.pay.find((x) => (roll -= x.weight) < 0) ?? w.pay[w.pay.length - 1]!;
  const quantity = w.base[kind] + hops * w.per_hop + (content.locations[zone]?.danger ?? 0) * w.per_danger;
  return quantity > 0 ? { id: item.item, quantity } : null;
}

/** 목표가 있는 곳을 의뢰인이 아는 만큼 (모르는 장소는 어림 단편, 12-282·283) */
export function questWhere(state: GameState, content: Content, q: Quest): string {
  const zone = content.locations[q.zone]?.name ?? q.zone;
  if (q.kind === "fetch") return `${zone} (${q.zone})`;
  if (!q.place) return `${zone} (${q.zone}) 어딘가`;
  const p = placeById(state, content, q.place, q.zone);
  if (p && knowsPlace(state, content, q.zone, q.place)) return `${zone} (${q.zone})의 ${p.name}`;
  const hint = placeHint(state, content, q.zone, q.place);
  return `${zone} (${q.zone})${hint ? `, ${hint}` : ""}`;
}

const kindLabel = (content: Content, kind: QuestKind) => content.scenario.requests?.kinds[kind].label ?? kind;
const payLabel = (content: Content, q: Quest) => (q.pay ? `${content.items[q.pay.id]?.name ?? q.pay.id} ×${q.pay.quantity}` : "고마움");

/** 의뢰인 앞에 함께 있는 사람 (장면·곁) */
const hereNow = (state: GameState) => [...state.scene.present, ...state.companions.filter((id) => !state.bonds[id]?.apart)];

/** 의뢰인이 말을 받을 수 있는가: 장면에 있거나, 같은 구역에 막 나갔으면 (부탁과 같다, 12-240) */
function giverProblem(state: GameState, content: Content, id: string): string | null {
  const bad = talkProblem(state, content, id, "맡긴다");
  if (!bad) return null;
  return inZone(state, content, id) && state.characters[id] && !state.characters[id]!.dead ? null : bad;
}

const requestTool = defineTool({
  name: "request",
  description:
    "의뢰 (보통의 RPG처럼 받는 반복 일거리). ask: 플레이어가 장면의 인물에게 일거리가 있는지 물으면 부른다. 그 사람이 줄 만한 의뢰(찾아오기·사람 찾기·붙잡아 오기·처치하기)와 목표·기한·보수를 시스템이 정한다. " +
    "accept·decline: 내놓은 의뢰(p_N)에 답한다. 받으면 목표가 세계에 생긴다. report: 의뢰인 앞에서 해낸 것을 보고한다 (해냈는지·보수는 시스템이 정한다. 찾아오기는 물건을 건넨다). " +
    "abandon: 받은 의뢰를 그만둔다 (기한을 넘긴 것처럼 의뢰인의 신뢰가 깎이고, 곧바로 다른 의뢰를 받을 수 있다). " +
    "진행 중인 의뢰는 한 번에 하나다 (인물이 먼저 꺼낸 부탁을 받은 것도 센다). 목표·보수를 지어내지 않는다.",
  schema: z.strictObject({
    action: z.enum(["ask", "accept", "decline", "report", "abandon"]),
    npc_id: z.string().nullable().default(null).describe("ask: 일거리를 묻는 상대 (장면에 있어야 한다)"),
    request_id: z.string().nullable().default(null).describe("accept·decline·report·abandon: 의뢰 id (p_N). report·abandon은 비우면 진행 중인 의뢰"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content, rng } = ctx;
    const r = content.scenario.requests;
    if (!r) return { ok: false, error: "이 월드에는 의뢰 규칙이 없다." };
    const state = store.getState();
    const me = state.characters[state.playerId];
    if (!me || me.dead) return { ok: false, error: "사망한 캐릭터는 의뢰를 받을 수 없다." };
    const today = dayOf(state.time);

    if (input.action === "ask") {
      if (!input.npc_id) return { ok: false, error: "ask에는 npc_id가 필요하다." };
      const bad = talkProblem(state, content, input.npc_id, "일거리를 묻는다");
      if (bad) return { ok: false, error: bad };
      const who = playerCalls(state, content, input.npc_id);
      const busy = activeRequest(state);
      if (busy) return { ok: false, error: `진행 중인 의뢰가 이미 있다 (${busy.id}: ${busy.what}). 의뢰는 한 번에 하나다. ${josa(who, "은/는")} 그 일부터 끝내라고 한다. 그만두려면 request abandon (신뢰가 깎인다).` };
      const waiting = offeredQuests(state, input.npc_id)[0];
      if (waiting) return { ok: true, resultText: offerText(state, content, who, waiting), display: QUIET };
      if ((state.relations[input.npc_id]?.[me.id]?.trust ?? 0) < -2) return { ok: true, resultText: `${josa(who, "은/는")} 당신에게 맡길 일이 없다고 한다 (믿지 않는다). 이 결과대로 서술하라.`, display: QUIET };
      const askedToday = (state.promises ?? []).some((p) => p.to === input.npc_id && questOf(p) && dayOf(p.made) === today);
      if (askedToday) return { ok: true, resultText: `${josa(who, "은/는")} 오늘은 더 맡길 일이 없다고 한다. 내일 다시 묻거나 다른 사람에게 묻는다. 이 결과대로 서술하라.`, display: QUIET };
      const offer = makeOffer(state, content, input.npc_id, rng);
      if (!offer) return { ok: true, resultText: `${josa(who, "은/는")} 지금 맡길 만한 일이 없다고 한다. 이 결과대로 서술하라.`, display: QUIET };
      const id = nextId(state);
      store.append({ type: "request_offered", id, by: me.id, to: input.npc_id, what: offer.what, due: today + 1, item: offer.item, quest: offer.goal });
      const p = (store.getState().promises ?? []).find((x) => x.id === id)!;
      return { ok: true, resultText: offerText(store.getState(), content, who, p), display: QUIET };
    }

    if (input.action === "accept" || input.action === "decline") {
      const p = offeredQuests(state).find((x) => x.id === input.request_id);
      if (!p) return { ok: false, error: `답할 수 있는 의뢰가 아니다: ${input.request_id ?? "(없음)"} (내놓은 의뢰: ${offeredQuests(state).map((x) => x.id).join(", ") || "없음"}. 인물이 먼저 꺼낸 부탁은 promise accept)` };
      const bad = giverProblem(state, content, p.to);
      if (bad) return { ok: false, error: `의뢰인이 장면에 있어야 한다: ${bad}` };
      const who = playerCalls(state, content, p.to);
      if (input.action === "decline") {
        store.append({ type: "promise_settled", id: p.id, status: "declined" });
        return { ok: true, resultText: `${who}의 의뢰를 거절했다. 관계는 그대로다. 이 결과대로 서술하라.`, display: QUIET };
      }
      const busy = activeRequest(state);
      if (busy) return { ok: false, error: `진행 중인 의뢰가 이미 있다 (${busy.id}). 의뢰는 한 번에 하나다. 그만두려면 request abandon (신뢰가 깎인다).` };
      const q = questOf(p)!;
      const days = q.days || between(rng, r.days) + q.hops * r.per_hop_days;
      const target = q.template ? placeTarget(ctx, q) : null;
      store.append({ type: "request_accepted", id: p.id, due: today + days, target });
      const now = store.getState();
      const where = questWhere(now, content, q);
      const t = target ? now.characters[target] : undefined;
      const fact = `${who}의 의뢰(${p.id}, ${kindLabel(content, q.kind)}): ${p.what}. ${q.kind === "fetch" ? "구할 만한 곳" : "있는 곳"}: ${where}`;
      store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: now.time, topic: questTopic(p.id) } });
      return {
        ok: true,
        resultText:
          `${who}의 의뢰를 받았다 (${p.id}, ${kindLabel(content, q.kind)}, ${days}일 안에): ${p.what}.\n` +
          (q.kind === "fetch" ? `구할 만한 곳: ${[where, ...itemSources(content, p.item!.id).slice(0, 2)].join(", ")}. 물건을 ${who}에게 건네면 해낸 것이다 (transfer_item 또는 request report).` : `있는 곳 (${josa(who, "이/가")} 아는 만큼): ${where}.${t?.extra ? ` 생김새: ${t.extra.look}.` : ""} ${q.kind === "find" ? `찾아 만나면 해낸 것이다 (데려오면 보수 +${r.reward.brought}). 그 뒤 의뢰인에게 request report.` : q.kind === "capture" ? "쓰러뜨려 handle_prisoner bind로 묶어 의뢰인 앞으로 끌고 와 request report. 죽이면 실패다." : "처치한 뒤 의뢰인에게 request report."}`) +
          `\n보수: ${payLabel(content, q)}. 기한을 넘기면 ${josa(who, "이/가")} 실망한다 (신뢰가 깎인다). 이 결과대로 ${who}의 말투로 일을 맡기는 장면을 서술하라. 목표의 이름·장소를 지어내지 않는다.`,
        display: QUIET,
      };
    }

    if (input.action === "abandon") {
      const p = input.request_id ? (state.promises ?? []).find((x) => x.id === input.request_id && x.by === me.id && x.status === "open") : activeRequest(state);
      if (!p) return { ok: false, error: `그만둘 의뢰가 없다: ${input.request_id ?? "(진행 중인 의뢰 없음)"}` };
      return { ok: true, resultText: abandonRequest(ctx, p).join("\n"), display: QUIET };
    }

    // report
    const p = input.request_id ? (state.promises ?? []).find((x) => x.id === input.request_id && x.by === me.id && x.status === "open") : activeRequest(state);
    if (!p) return { ok: false, error: `보고할 의뢰가 없다: ${input.request_id ?? "(진행 중인 의뢰 없음)"}` };
    const bad = talkProblem(state, content, p.to, "보고한다");
    if (bad) return { ok: false, error: `의뢰는 의뢰인 앞에서 보고한다: ${bad}` };
    const q = questOf(p);
    if (!q || q.kind === "fetch") {
      const handed = handOver(ctx, p);
      return typeof handed === "string" ? { ok: false, error: handed } : { ok: true, resultText: handed.join("\n"), display: QUIET };
    }
    const prog = questProgress(state, content, p, hereNow(state));
    if (!prog.done) return { ok: false, error: `아직 해내지 못했다: ${prog.left}. 목표가 있는 곳: ${questWhere(state, content, q)}` };
    const lines: string[] = [];
    const target = q.target;
    const giver = state.characters[p.to]!;
    const at = keepingPlaceOf(state, content, p.to);
    if (prog.brought && target && q.kind === "find" && at?.zone) {
      store.append({ type: "extra_rehomed", characterId: target, zone: at.zone, place: at.place });
      lines.push(`데려온 ${josa(playerCalls(state, content, target), "은/는")} 이제 ${playerCalls(state, content, p.to)} 곁에 머문다.`);
    }
    if (prog.brought && target && q.kind === "capture") {
      // 넘겨받아 가두는 것은 의뢰인 무리의 땅에서만: 들판에서 보고하면 포로는 그대로 끌고 다닌다 (12-293, PT25 분대장: 구시가 길에서 보고하자 포로가 거점 수용소로 순간이동)
      if (giver.factionId && state.playerZone && ownedBy(state, state.playerZone, giver.factionId)) {
        captureNpc(ctx, target, giver.factionId, state.playerZone);
        lines.push(`끌고 온 ${josa(playerCalls(state, content, target), "을/를")} ${josa(playerCalls(state, content, p.to), "이/가")} 넘겨받아 가뒀다.`);
      } else if (!giver.factionId) {
        store.append({ type: "npc_departed", npcId: target, toFaction: null });
        lines.push(`끌고 온 ${josa(playerCalls(state, content, target), "을/를")} ${josa(playerCalls(state, content, p.to), "이/가")} 넘겨받아 데려갔다.`);
      } else lines.push(`${josa(playerCalls(state, content, target), "은/는")} 아직 묶인 채 당신이 끌고 간다. 거점에 닿으면 가둔다.`);
    }
    const extra = prog.brought && q.kind === "find" ? r.reward.brought : 0;
    return { ok: true, resultText: [...settleKept(ctx, p, extra), ...lines].join("\n"), display: QUIET };
  },
});

/** 받은 의뢰의 목표를 세계에 둔다: 그 틀의 엑스트라를 목표 구역의 장소에 (아직 아무도 만나지 않았다) */
function placeTarget(ctx: ToolContext, q: Quest): string | null {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const template = q.template ? content.extras[q.template] : undefined;
  if (!template) return null;
  const id = `ex_${state.nextExtraNo}`;
  const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
  const usedLooks = new Set(Object.values(state.characters).flatMap((c) => (c.extra ? [c.extra.look] : [])));
  const character = createExtraCharacter(content, template, { id, label: template.label, zone: q.zone, time: state.time, usedNames, usedLooks }, rng);
  character.extra = { ...character.extra!, place: q.place };
  store.append({ type: "extra_spawned", character, unseen: true });
  return id;
}

function offerText(state: GameState, content: Content, who: string, p: GameState["promises"][number]): string {
  const q = questOf(p)!;
  const r = content.scenario.requests!;
  const days = q.days || `${r.days[0] + q.hops * r.per_hop_days}~${r.days[1] + q.hops * r.per_hop_days}`;
  return (
    `${josa(who, "이/가")} 맡길 일 (${p.id}, ${kindLabel(content, q.kind)}): ${p.what}. ${q.kind === "fetch" ? "구할 만한 곳" : "있는 곳"}: ${questWhere(state, content, q)}. ` +
    `기한 ${days}일, 보수 ${payLabel(content, q)}.\n` +
    `${who}의 말투로 일거리를 꺼내는 장면을 서술하고, 플레이어가 받으면 request accept, 거절하면 decline (오늘 안에 답한다). 목표의 이름·장소·보수를 지어내지 않는다.`
  );
}

/** 인물 카드: 이 사람이 내놓았고 아직 답하지 않은 의뢰 */
export function requestOfferLines(state: GameState, content: Content, to: string): string[] {
  return offeredQuests(state, to).map((p) => `이 인물이 내놓은 의뢰 ${p.id} (답을 기다린다, request accept·decline): ${p.what} — ${questWhere(state, content, questOf(p)!)}`);
}

/** GM 상태의 "진행 중인 의뢰" 줄 */
export function describeRequestForGm(state: GameState, content: Content): string {
  if (!content.scenario.requests) return "";
  const p = activeRequest(state);
  if (!p) return "진행 중인 의뢰: 없음 (장면의 인물에게 일거리를 물으면 request ask. 한 번에 하나)";
  const who = playerCalls(state, content, p.to);
  const left = p.due - dayOf(state.time);
  const q = questOf(p);
  const head = `진행 중인 의뢰 ${p.id} (${q ? kindLabel(content, q.kind) : "인물의 부탁"}, 의뢰인 ${who} ${p.to}): ${p.what} — ${left > 0 ? `${left}일 남음` : "오늘까지"}`;
  if (!q) return head;
  const prog = q.kind === "fetch" ? null : questProgress(state, content, p, hereNow(state));
  return `${head}. ${q.kind === "fetch" ? "구할 만한 곳" : "있는 곳"}: ${questWhere(state, content, q)}. ${prog ? (prog.done ? "해냈다: 의뢰인 앞에서 request report" : `남은 일: ${prog.left}`) : "물건을 의뢰인에게 건네면 끝난다"}`;
}

export const REQUEST_TOOLS = [requestTool] as const;

/** 사람에게만 맡길 수 있다 (감염체·짐승은 일거리를 주지 않는다): content:check·테스트용 */
export const canGive = (state: GameState, content: Content, id: string): boolean => !!state.characters[id] && !isCreature(content, state.characters[id]!) && !!giverRule(state, content, id);
