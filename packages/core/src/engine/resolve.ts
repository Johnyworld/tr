import { knownOwner } from "../rules/knowledge.ts";
import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { tiesOf } from "../game/ties.ts";
import { checkPromotion, commanderOf, recentSetback } from "../game/missions.ts";
import { disciplineOf } from "../game/culture.ts";
import { josa } from "../text.ts";
import { fill } from "../text.ts";
import { z } from "zod";
import { RESOLVE_CHECK_IDS, RESOLVE_TARGET } from "../scenario/schema.ts";
export { RESOLVE_TARGET };
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { fameOf } from "../game/fame.ts";
import { standingInFaction } from "../game/politics.ts";
import type { GameState } from "../game/state.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { seasonAt } from "../sim/season.ts";
import { changeCondition } from "./body.ts";
import { gainResolveXp } from "./growth.ts";
import { loversOf } from "./romance.ts";
import { traitIdsOf } from "./traits.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";
import { ownedBy } from "../rules/home.ts";

/**
 * 다짐 (기획서 3.5, 12-164). 주인공의 큰 줄기 (메인 임무에 가까운 것). 한 번에 하나.
 * - 생기는 길은 둘: 시나리오(역할의 resolve, 없으면 배경 history를 resolve.from_history로 읽는다), 플레이 중 이야기 효과 resolve
 * - 이뤘는지·꺾였는지는 코드가 지금 상태를 읽어 정한다 (판정 종류 RESOLVE_CHECKS). tool이 끝날 때마다 본다
 * - 갚기처럼 let_go인 갈래는 스스로 내려놓을 수 있다 (resolve tool). 내려놓아도 이룬 다짐으로 친다
 * - 무리·구역을 대상으로 하는 다짐은 주인공이 그 전투에 끼지 않고 이뤄지면 "남의 손으로 이뤘다"
 */

export const RESOLVE_CHECKS = RESOLVE_CHECK_IDS;
export type ResolveCheck = (typeof RESOLVE_CHECKS)[number];

/** 사람이 죽으면 꺾이는 판정 */
const BROKEN_BY_DEATH: ReadonlySet<ResolveCheck> = new Set(["meet", "released", "cured", "alive_days", "promise_kept", "relation"]);
/** 주인공이 끼지 않아도 이뤄질 수 있는 판정 (무리·구역) */
const BY_OTHERS: ReadonlySet<ResolveCheck> = new Set(["faction_fallen", "zone_owned", "truce"]);

export type Resolve = NonNullable<GameState["resolves"][string]>;
export type ResolveOutcome = "achieved" | "let_go" | "broken" | "by_others";

const rules = (content: Content) => content.scenario.resolve;
export const kindOf = (content: Content, id: string) => rules(content)?.kinds.find((k) => k.id === id);

/** 지금 주인공의 다짐 */
export function currentResolve(state: GameState): Resolve | null {
  return state.resolves?.[state.playerId] ?? null;
}

/** 이룬 것인지 (true), 꺾인 것인지 (false), 아직인지 (null). 갈래의 min_stage에 못 미치면 이뤄도 아직이다 (12-193) */
function evaluate(content: Content, state: GameState, r: Resolve): boolean | null {
  const result = evaluateCheck(content, state, r);
  if (result === true && (r.stage ?? 0) < (kindOf(content, r.kind)?.min_stage ?? 0)) return null;
  return result;
}

function evaluateCheck(content: Content, state: GameState, r: Resolve): boolean | null {
  const kind = kindOf(content, r.kind);
  if (!kind) return null;
  const me = state.characters[state.playerId]!;
  const t = r.target ? state.characters[r.target] : undefined;
  if (BROKEN_BY_DEATH.has(kind.check) && t?.dead) return false;
  switch (kind.check) {
    case "meet": {
      // 살아서 주인공 앞에 나타났다 (같은 장면). 찾는 가족이면 가족 누구를 만나도 (플레이 테스트 12: 재회 이야기는 언니를 데려왔는데 다짐 대상은 어머니라 0단계로 남았다)
      const family = state.family ?? [];
      const who = r.target && family.includes(r.target) ? family : r.target ? [r.target] : [];
      return who.some((id) => !state.characters[id]?.dead && state.scene.present.includes(id)) ? true : null;
    }
    case "gone":
      // 주인공이 알 때만: 유해가 있는 자리에 있거나(눈앞에서 죽었거나 시신을 찾았다), 우리 무리가 가뒀다 (원칙 4)
      if (t?.dead) return state.remains.some((x) => x.of === r.target && x.zone === state.playerZone) ? true : null;
      return heldOf(t) && me.factionId && heldOf(t)!.by === me.factionId ? true : null;
    case "released":
      return t && !t.dead && !heldOf(t) ? true : null;
    case "cured": {
      const track = content.scenario.body?.infection?.track;
      return t && track && (t.conditions[track] ?? "") === content.scenario.condition_tracks.find((x) => x.id === track)?.levels[0]?.id ? true : null;
    }
    case "alive_days":
      return t && !t.dead && state.time - r.since >= (r.n ?? 1) * MINUTES_PER_DAY ? true : null;
    case "promise_kept":
      return (state.promises ?? []).some((p) => p.to === r.target && p.status === "kept" && p.made >= r.since) ? true : null;
    case "rank": {
      if (!me.factionId) return false;
      const ladder = content.scenario.rank_ladder;
      const level = (id: string) => ladder.find((x) => x.id === id)?.level ?? 0;
      return level(me.rank) >= level(r.target ?? "") ? true : null;
    }
    case "debt_clear":
      return (me.debts[r.target ?? ""] ?? 0) <= 0 ? true : null;
    case "reach":
      // 그곳을 떠나 있다가 닿아야 한다 (처음부터 그곳에 있으면 이룬 것이 아니다)
      // 갇혀 있으면 닿은 것이 아니다 (플레이 테스트 13: 그 구역 감옥에서 자다 "우리 집에 가 봤다"). 그 자리에서 풀려나면 닿은 것
      return r.involved && state.playerZone === r.target && !pausedWhileHeld(state, "resolve_reach") ? true : null;
    case "beliefs": {
      const words = (r.target ?? "").split("|").filter(Boolean);
      const n = (state.beliefs[state.playerId] ?? []).filter((b) => words.some((w) => b.fact.includes(w))).length;
      return n >= (r.n ?? 1) ? true : null;
    }
    case "fame":
      return fameOf(state, content).tier >= (r.n ?? 1) ? true : null;
    case "relation":
      return r.target && loversOf(state, content, state.playerId).includes(r.target) ? true : null;
    case "trait_gone":
      return !traitIdsOf(content, me).includes(r.target ?? "") ? true : null;
    case "season_passed": {
      // 그 계절에 들어갔다가 벗어날 때까지 살아 있으면
      let entered = false;
      for (let d = dayOf(r.since); d <= dayOf(state.time); d++) {
        const id = seasonAt(content.scenario, (d - 1) * MINUTES_PER_DAY)?.id;
        if (id === r.target) entered = true;
        else if (entered) return true;
      }
      return null;
    }
    case "buried":
      return state.remains.some((x) => x.of === r.target && (x.buriedAt !== null || x.zone === state.playerZone)) ? true : null;
    case "truce":
      return (state.pacts ?? []).some((p) => p.kind === "truce" && p.until > state.time && ((p.a === r.target && p.b === r.target2) || (p.a === r.target2 && p.b === r.target))) ? true : null;
    case "faction_fallen": {
      const f = r.target ?? "";
      const bases = Object.entries(state.zones).filter(([z, info]) => info.owner === f && content.locations[z]?.kind === "base");
      return bases.length === 0 ? true : null;
    }
    case "zone_owned":
      return !!me.factionId && ownedBy(state, r.target ?? "", me.factionId) ? true : null;
    case "standing":
      return (me.occupation?.standing ?? -1) >= (r.n ?? 1) ? true : null;
    case "trusted": {
      // 속죄: 무리 안에 나를 믿지 않는 사람이 없고, 믿는 사람이 n명 이상
      const st = standingInFaction(state, content, state.playerId);
      return me.factionId && st.distrust === 0 && st.trust >= (r.n ?? 3) ? true : null;
    }
    case "ruins_found":
      return (state.ruinsFound?.[state.playerId] ?? []).length >= (r.n ?? 1) ? true : null;
  }
}

/** 다짐을 끝낸다: 보상(이룸)이나 마음의 상처(꺾임), 기록. GM에게 알릴 줄 */
function finish(ctx: ToolContext, r: Resolve, outcome: ResolveOutcome): { line: string; displays: ToolDisplayEvent[] } {
  const rule = rules(ctx.content)!;
  const state = ctx.store.getState();
  const me = state.playerId;
  // 기록에는 그때 부르던 대로 남긴다
  ctx.store.append({ type: "resolve_ended", characterId: me, outcome, text: resolveText(state, ctx.content, r) });
  const displays: ToolDisplayEvent[] = [];
  if (outcome === "broken") {
    const c = changeCondition(ctx, me, rule.relief_track, 1, "resolve", "꺾인 다짐");
    if (c?.display) displays.push(c.display);
    return { line: `(다짐이 꺾였다: ${resolveText(state, ctx.content, r)}. 이 상실을 장면에 담는다. 이야기가 새 다짐을 건넬 수 있다)`, displays };
  }
  const level = gainResolveXp(ctx, me, rule.xp);
  const c = changeCondition(ctx, me, rule.relief_track, -1, "resolve", "이룬 다짐");
  if (c?.display) displays.push(c.display);
  const how = outcome === "let_go" ? "내려놓았다" : outcome === "by_others" ? "이뤘다 (남의 손으로)" : "이뤘다";
  return { line: `(다짐을 ${how}: ${resolveText(state, ctx.content, r)}. 이 순간을 이번 장면의 무게 중심으로 연출한다.${level ? ` ${level}` : ""})`, displays };
}

/** tool이 끝날 때마다: 지금 다짐을 이뤘는지·꺾였는지 본다. 무리·구역 다짐이면 그 전투에 낀 것을 기억한다 */
export function checkResolve(ctx: ToolContext): { lines: string[]; displays: ToolDisplayEvent[] } {
  let state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || !rules(ctx.content)) return { lines: [], displays: [] };
  // 시나리오의 다짐은 그 캐릭터의 첫 판정 때 한 번 세운다 (시나리오 없이 이어 가는 계승 캐릭터는 없다)
  const seeded: string[] = [];
  if (!(state.resolveSeeded ?? []).includes(me.id)) {
    ctx.store.append({ type: "resolve_seeded", characterId: me.id });
    if (!currentResolve(state)) {
      // 이미 있던 사람으로 이어 가면 그 사람의 처지에서 (플레이 테스트 12). 새로 만든 캐릭터는 시나리오가 없으면 다짐 없이
      const existing = !!ctx.content.npcs[me.id] || !!me.extra;
      const line = state.scenarioRole ? scenarioResolve(ctx, state.scenarioRole) : existing ? heirResolve(ctx) : null;
      if (line) seeded.push(`(${line}. 이것이 이 주인공의 큰 줄기다. 서두르게 하지도 말리지도 않는다)`);
    }
    state = ctx.store.getState();
  }
  const r = currentResolve(state);
  if (!r) return { lines: seeded, displays: [] };
  const kind = kindOf(ctx.content, r.kind);
  if (kind?.check === "reach" && !r.involved && state.playerZone !== r.target) ctx.store.append({ type: "resolve_involved", characterId: me.id });
  if (kind && BY_OTHERS.has(kind.check) && !r.involved && state.battle) {
    const b = state.battle as { zone?: string; theirs?: { faction?: string } };
    if (b.zone === r.target || b.theirs?.faction === r.target || b.theirs?.faction === r.target2) ctx.store.append({ type: "resolve_involved", characterId: me.id });
  }
  autoStep(ctx);
  // 세운 그 순간에는 보지 않는다 (C2, 플레이 테스트 10: 혈청을 구하겠다고 한 자리에서 "이뤘다"가 됐다)
  if (currentResolve(ctx.store.getState())!.since === ctx.store.getState().time) return { lines: seeded, displays: [] };
  const result = evaluate(ctx.content, ctx.store.getState(), currentResolve(ctx.store.getState())!);
  if (result === null) return { lines: seeded, displays: [] };
  const now = currentResolve(ctx.store.getState())!;
  const outcome: ResolveOutcome = !result ? "broken" : kind && BY_OTHERS.has(kind.check) && !now.involved ? "by_others" : "achieved";
  const done = finish(ctx, now, outcome);
  return { lines: [...seeded, done.line], displays: done.displays };
}

/**
 * 코드가 올리는 단계 (플레이 테스트 12): 다짐의 대상과 함께한 날마다 한 단계(사람이면 곁에, 곳이면 그곳에. 하루 한 번),
 * 빚 다짐은 빚을 갚을 때마다 한 단계. 이야기의 resolve_step은 그대로 따로 오른다
 */
function autoStep(ctx: ToolContext): void {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const r = currentResolve(state);
  if (!r?.target) return;
  const kind = kindOf(ctx.content, r.kind);
  const name = resolveTargetName(state, ctx.content) ?? r.target;
  if (kind?.check === "debt_clear") {
    const debt = me.debts[r.target] ?? 0;
    if (r.mark === undefined || debt > r.mark) ctx.store.append({ type: "resolve_tracked", characterId: me.id, mark: debt });
    else if (debt < r.mark) {
      ctx.store.append({ type: "resolve_stepped", characterId: me.id, text: `${name}에 진 빚을 조금 갚았다` });
      ctx.store.append({ type: "resolve_tracked", characterId: me.id, mark: debt });
    }
    return;
  }
  const today = dayOf(state.time);
  // 첫 단계는 다짐이 생긴 날이 지난 뒤부터 (플레이 테스트 13: 생긴 지 5분 만에 "하루를 함께했다")
  if (r.autoDay === today || dayOf(r.since) === today) return;
  const person = state.characters[r.target];
  const together = person ? !person.dead && (state.scene.present.includes(r.target) || state.companions.includes(r.target)) : state.playerZone === r.target && !pausedWhileHeld(state, "resolve_reach");
  if (!together) return;
  const text = !person ? `${name}에 닿았다` : kind?.check === "gone" ? `${josa(name, "을/를")} 마주쳤다` : `${josa(name, "과/와")} 하루를 함께했다`;
  ctx.store.append({ type: "resolve_stepped", characterId: me.id, text });
  ctx.store.append({ type: "resolve_tracked", characterId: me.id, day: today });
}

/** 다짐을 세운다 (시나리오 시작, 이야기 효과). 대상은 캐릭터·구역·무리·등급 id */
export function setResolve(ctx: ToolContext, input: { kind: string; target?: string | null; target2?: string | null; n?: number | null; text: string }, source: "scenario" | "story"): string | null {
  const kind = kindOf(ctx.content, input.kind);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!kind || !me || me.dead) return null;
  if (kind.occupation_only && !me.occupation) return null;
  // 품은 다짐은 덮어쓰지 않는다 (12-199: 곁가지 다짐이 시나리오의 복수 다짐을 지웠다). 이루거나 꺾이면 이야기가 새 다짐을 건넨다
  if (currentResolve(state)) return null;
  ctx.store.append({
    type: "resolve_set",
    characterId: me.id,
    resolve: { kind: kind.id, target: input.target ?? null, target2: input.target2 ?? null, n: input.n ?? null, text: input.text, since: state.time, source, involved: false, stage: 0, step: null },
  });
  return `새 다짐: ${resolveText(ctx.store.getState(), ctx.content)}`;
}

/** 시나리오의 다짐: 역할에 resolve가 있으면 그것, 없으면 배경(history)을 resolve.from_history로 읽는다 */
export function scenarioResolve(ctx: ToolContext, roleId: string): string | null {
  const role = ctx.content.roles[roleId];
  const rule = rules(ctx.content);
  if (!role || !rule) return null;
  if (role.resolve) return setResolve(ctx, role.resolve, "scenario");
  const state = ctx.store.getState();
  for (const part of role.history ?? []) {
    if (part.kind === "enemy" && rule.from_history.enemy && ctx.content.npcs[part.target]) {
      // 대상은 주인공이 부르는 말로 그때그때 (이름을 모르면 호칭, 알게 되면 이름)
      return setResolve(ctx, { kind: rule.from_history.enemy, target: part.target, text: "{target}에게 갚는다" }, "scenario");
    }
  }
  const family = state.family[0];
  if (family && rule.from_history.family) return setResolve(ctx, { kind: rule.from_history.family, target: family, text: "헤어진 가족을 찾는다" }, "scenario");
  const debt = Object.entries(state.characters[state.playerId]?.debts ?? {}).find(([, n]) => n > 0);
  if (debt && rule.from_history.debt) {
    return setResolve(ctx, { kind: rule.from_history.debt, target: debt[0], text: `${ctx.content.factions[debt[0]]?.name ?? debt[0]}에 진 빚을 턴다` }, "scenario");
  }
  return null;
}

/** 이어받은 사람의 다짐: 빚이 있으면 빚 털기, 아니면 살아 있는 가까운 사람(피붙이·연인·친구)을 지키기 */
function heirResolve(ctx: ToolContext): string | null {
  const rule = rules(ctx.content);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!rule || !me) return null;
  const debt = Object.entries(me.debts ?? {}).find(([, n]) => n > 0);
  if (debt && rule.from_history.debt) return setResolve(ctx, { kind: rule.from_history.debt, target: debt[0], text: `${ctx.content.factions[debt[0]]?.name ?? debt[0]}에 진 빚을 턴다` }, "scenario");
  if (!rule.heir?.close) return null;
  const close = tiesOf(state, ctx.content, me.id).find((t) => ["parent", "child", "sibling", "spouse", "lover", "friend"].includes(t.kind) && !t.secret && state.characters[t.other] && !state.characters[t.other]!.dead);
  if (!close) return null;
  return setResolve(ctx, { kind: rule.heir.close, target: close.other, n: rule.heir.days, text: "{target:을/를} 지킨다" }, "scenario");
}

/** 다짐 한 줄 (대상 자리 {target}을 주인공이 지금 부르는 말로 채운다) */
export function resolveText(state: GameState, content: Content, r: Resolve | null | undefined = currentResolve(state)): string {
  if (!r) return "";
  const t = r.target && state.characters[r.target] ? playerCalls(state, content, r.target) : (resolveTargetNameOf(state, content, r.target) ?? "");
  return fill(r.text, { target: t });
}

/** 다짐 한 줄 (상태 화면·?임무): 다짐과 지금 어디까지 왔는지 */
export function resolveLine(state: GameState, content: Content): string | null {
  const r = currentResolve(state);
  if (!r) return null;
  const progress = resolveProgress(state, content, r);
  return `${resolveText(state, content, r)}${resolvePlace(state, content, r)}${progress ? ` — ${progress}` : r.step ? ` — ${r.step}` : ""}`;
}

/** 대상이 구역이면 그곳이 지금 어디인지 (플레이 테스트 13: "옛 아파트 단지"가 어디인지 몰랐다). 주인공이 본 대로의 땅 주인 */
function resolvePlace(state: GameState, content: Content, r: NonNullable<ReturnType<typeof currentResolve>>): string {
  const zone = r.target ? content.locations[r.target] : undefined;
  if (!zone) return "";
  // 주인공이 아는 대로 (공통 규칙 7)
  const seen = knownOwner(state, content, zone.id);
  const owner = seen ? content.factions[seen]?.name : null;
  return ` (그곳: ${zone.name}${owner ? `, ${owner}의 땅` : ""})`;
}

function resolveTargetNameOf(state: GameState, content: Content, t: string | null): string | null {
  if (!t) return null;
  return content.locations[t]?.name ?? content.factions[t]?.name ?? content.scenario.rank_ladder.find((x) => x.id === t)?.label ?? null;
}

/** 다짐의 대상을 주인공이 부르는 말 (사람·구역·무리·등급) */
export function resolveTargetName(state: GameState, content: Content): string | null {
  const r = currentResolve(state);
  const t = r?.target;
  if (!t) return null;
  if (state.characters[t]) return playerCalls(state, content, t);
  return content.locations[t]?.name ?? content.factions[t]?.name ?? content.scenario.rank_ladder.find((x) => x.id === t)?.label ?? null;
}

/** 이야기 효과 resolve_step: 단계를 한 칸 올린다 */
export function stepResolve(ctx: ToolContext, text: string): string | null {
  const state = ctx.store.getState();
  if (!currentResolve(state)) return null;
  ctx.store.append({ type: "resolve_stepped", characterId: state.playerId, text });
  return `다짐에 한 걸음 다가갔다: ${text}`;
}

/**
 * 날마다 오르는 단계가 없는 다짐(자리·진실·인정받기)은 실제로 채운 정도를 보인다 (플레이 테스트 13: 단서를 여덟 개 풀어도 "진실, 0단계")
 * 없으면 null (단계를 쓴다)
 */
export function resolveProgress(state: GameState, content: Content, r = currentResolve(state)): string | null {
  if (!r) return null;
  const kind = kindOf(content, r.kind);
  const me = state.characters[state.playerId];
  if (!kind || !me) return null;
  if (kind.check === "beliefs") {
    const words = (r.target ?? "").split("|").filter(Boolean);
    const n = (state.beliefs[state.playerId] ?? []).filter((b) => words.some((w) => b.fact.includes(w))).length;
    return `알아낸 것 ${Math.min(n, r.n ?? 1)}/${r.n ?? 1}`;
  }
  if (kind.check === "standing") return `평판 ${Math.max(0, me.occupation?.standing ?? 0)}/${r.n ?? 1}`;
  if (kind.check === "rank") {
    const promotion = content.scenario.promotion;
    if (!promotion || me.rank !== promotion.from) return null;
    const commanderId = commanderOf(state, content);
    const trust = commanderId ? (state.relations[commanderId]?.[me.id]?.trust ?? 0) : null;
    const missing = checkPromotion(me, promotion, state.time, state.runStartedAt, trust, disciplineOf(content, me.factionId).maxDisobedience, recentSetback(state, me.id, commanderId)).missing;
    return missing.length ? `진급까지 남은 것: ${missing.join(", ")}` : "진급 조건을 다 채웠다";
  }
  return null;
}

/** GM 상태의 줄 */
export function describeResolve(state: GameState, content: Content): string[] {
  const r = currentResolve(state);
  if (!r) return [];
  const kind = kindOf(content, r.kind);
  const text = resolveText(state, content, r);
  // 다짐 문구에 이미 대상이 나오면 다시 적지 않는다
  const name = r.target && state.characters[r.target] ? playerCalls(state, content, r.target) : null;
  const who = name && !text.includes(name) ? ` (대상: ${name})` : "";
  const progress = resolveProgress(state, content, r);
  const place = resolvePlace(state, content, r);
  return [
    (progress
      ? `주인공의 다짐: ${text}${who}${place} — ${kind?.label ?? r.kind}, ${progress}${r.step ? ` (${r.step})` : ""}.`
      : `주인공의 다짐: ${text}${who}${place} — ${kind?.label ?? r.kind}, ${r.stage ?? 0}단계${r.step ? ` (${r.step})` : ""}${kind?.min_stage ? ` (이루려면 ${kind.min_stage}단계 이상)` : ""}. 단계는 ${kind?.check === "debt_clear" ? "빚을 갚을 때마다" : "대상과 한 장면에 있었던(곳이면 그곳에 닿은) 날마다"}, 그리고 이야기로 오른다.`) +
      ` 이뤘는지는 시스템이 정한다. 서두르게 하지도 말리지도 않는다${kind?.let_go ? ". 플레이어가 분명히 내려놓으면 resolve {action: let_go}" : ""}`,
  ];
}

const resolveTool = defineTool({
  name: "resolve",
  description:
    "주인공의 다짐(메인 줄기)을 스스로 내려놓는다 (갚기처럼 내려놓을 수 있는 다짐만). 플레이어가 장면에서 분명히 용서하거나 포기했을 때만 부른다. " +
    "내려놓아도 이룬 다짐으로 친다 (보상은 시스템이 준다). 다짐을 세우거나 이뤘다고 알리는 데는 쓰지 않는다 (시스템이 정한다).",
  schema: z.strictObject({ action: z.literal("let_go"), why: z.string().min(1).max(120).describe("내려놓은 까닭 한 줄 (연대기에 남는다)") }),
  run(input, ctx): ToolOutcome {
    const state = ctx.store.getState();
    const r = currentResolve(state);
    if (!r) return { ok: false, error: "지금 품은 다짐이 없다." };
    const kind = kindOf(ctx.content, r.kind);
    if (!kind?.let_go) return { ok: false, error: `이 다짐(${kind?.label ?? r.kind})은 내려놓는 길이 없다. 이루거나 꺾일 뿐이다.` };
    ctx.store.append({ type: "resolve_note", characterId: state.playerId, note: input.why.trim() });
    const done = finish(ctx, r, "let_go");
    return { ok: true, resultText: done.line, display: done.displays[0] ?? { type: "time", activityLabel: "다짐", durationLabel: "", fromLabel: "", toLabel: "" }, extra: done.displays.slice(1) };
  },
});

export const RESOLVE_TOOLS = [resolveTool] as const;

/** 연대기 줄: 그 캐릭터가 이루거나 꺾거나 내려놓은 다짐 */
export function resolveChronicle(state: GameState, content: Content, characterId: string): string[] {
  const label: Record<ResolveOutcome, string> = { achieved: "이룬 다짐", let_go: "내려놓은 다짐", broken: "꺾인 다짐", by_others: "남의 손으로 이룬 다짐" };
  const ended = (state.resolveLog ?? []).filter((x) => x.characterId === characterId).map((x) => `${label[x.outcome]}: ${x.text}${x.note ? ` (${x.note})` : ""}`);
  // 죽을 때까지 품고 있던 다짐
  const open = state.resolves?.[characterId];
  return open && state.characters[characterId]?.dead ? [...ended, `못 이룬 다짐: ${resolveText(state, content, open)}`] : ended;
}

