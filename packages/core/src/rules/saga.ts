/**
 * 공통 규칙 24: 큰 이야기 (docs/saga-plan.md, docs/design/10-scenarios.md).
 *
 * 월드 공통 장편 줄기. 오픈월드 RPG의 DLC처럼 문 조건이 차면 열리고, 시작 사건(꼭 열리는 이야기)이 1막으로 넘긴다.
 * - 문 (opens): 날짜·시나리오 이야기 수·플래그·하지 않는 시나리오·앞 큰 이야기의 결말. 진행 중인 큰 이야기가 있으면 기다린다 (하나까지)
 * - 막 (acts): 기한(days)이 있다. 이야기 효과 saga_advance가 넘기고, 기한을 넘기면 세계 쪽 사건(lapse)이 일어나 넘긴다 (주인공이 없어도)
 * - 결말 (endings): 이야기 효과 saga_end, 또는 마지막 막의 기한. 결말의 효과와 상인 물건 배율이 세계를 바꾼다
 * - 실마리 한 줄 (note): 퀘스트 줄 설명. 이야기 효과 saga_note, 막의 line, 세계 쪽 사건의 note, 플래그 실마리 표(notes)
 * - 등뼈 이야기 (when.saga.spine): 기한 이틀 전부터 이야기의 자리 "꼭" 등급 (공통 규칙 17)
 * - 곁의 R (mark): 정한 막이 시작될 때 주인공과 가까운 사람 중에서 고른다. 없으면 fallback 배역, 그도 없으면 비워 둔다 (이야기가 saga_mark로 들인다)
 * 큰 이야기는 세계의 것이다: 주인공이 죽어도 막과 시계는 그대로다. 상태(sagas)는 이 모듈과 리듀서만 읽는다 (rules/guards.test.ts).
 */
import type { Content, SagaContent, StoryletContent, StoryletEffect } from "../content/schemas.ts";
import type { GameState, SagaState } from "../game/state.ts";
import type { ToolContext, ToolDisplayEvent } from "../engine/toolkit.ts";
import { activeCompanions } from "../game/companions.ts";
import { tiesOf } from "../game/ties.ts";
import { hasMet, playerCalls } from "../game/acquaintance.ts";
import { hearNews } from "./news.ts";
import { dayOf, MINUTES_PER_DAY, type GameTime } from "./time.ts";
import { heldOf } from "./held.ts";

/**
 * 이야기 효과를 적용하는 함수 (세계 쪽 사건·결말의 효과). 부르는 쪽(engine)이 넘긴다:
 * 이 모듈이 엔진을 불러오면 공통 규칙 17(storySlot)과 순환 import가 된다
 */
export type SagaEffectApplier = (effect: StoryletEffect, cast: Record<string, string>, reason: string) => { line?: string; display?: ToolDisplayEvent; displays?: ToolDisplayEvent[] };

/** 큰 이야기의 이야기에 붙이는 태그: 어느 시나리오에서나 열리고, 등급은 시나리오 (공통이 아니다) */
export const SAGA_TAG = "saga";
/** 등뼈 이야기가 꼭 등급으로 오르는 때: 기한까지 이만큼 남으면 */
const SPINE_DUE_MINUTES = 2 * MINUTES_PER_DAY;
/** 곁의 R이 될 만한 사람: 이만큼 믿거나 아끼는 사람 */
const CLOSE_REGARD = 6;
const CLOSE_TIES = new Set(["parent", "child", "sibling", "spouse", "lover", "friend"]);

const sagasOf = (state: GameState): Record<string, SagaState> => state.sagas ?? {};

/** 그 큰 이야기의 상태 (문이 열리지 않았으면 없다) */
export function sagaState(state: GameState, id: string): SagaState | null {
  return sagasOf(state)[id] ?? null;
}

const actOf = (saga: SagaContent, id: string) => saga.acts.find((a) => a.id === id);
const inProgress = (g: SagaState) => g.act !== "ended";
const started = (g: SagaState) => g.act !== "open" && g.act !== "ended";

/** 지금 진행 중인 큰 이야기 (시작 사건 뒤, 끝나기 전). 하나까지 */
export function activeSaga(state: GameState, content: Content): { saga: SagaContent; g: SagaState } | null {
  for (const [id, g] of Object.entries(sagasOf(state))) {
    const saga = content.sagas[id];
    if (saga && started(g)) return { saga, g };
  }
  return null;
}

/** 이 막의 기한 (시각). 기한이 없으면 null */
function deadlineOf(g: SagaState): GameTime | null {
  return g.days === null ? null : g.actStartedAt + Math.round(g.days * MINUTES_PER_DAY);
}

/** 큰 이야기의 정해 둔 사람과 곁의 R (세계 쪽 사건·결말의 효과가 who로 부른다) */
function sagaCast(saga: SagaContent, g: SagaState): Record<string, string> {
  return { ...saga.cast, ...(g.marked ? { marked: g.marked } : {}) };
}

/** 시나리오(역할) 이야기가 몇 번 열렸나: 공통·큰 이야기가 아닌 태그가 붙은 이야기 */
function roleStoriesFired(state: GameState, content: Content): number {
  return Object.keys(state.storyletLog).filter((id) => {
    const tags = content.storylets[id]?.tags ?? [];
    return tags.length > 0 && !tags.includes("world") && !tags.includes(SAGA_TAG);
  }).length;
}

/** 문이 열리는가 (파트 2·7) */
function doorOpens(state: GameState, content: Content, saga: SagaContent): boolean {
  if (sagaState(state, saga.id)) return false;
  if (Object.values(sagasOf(state)).some(inProgress)) return false;
  const o = saga.opens;
  if (dayOf(state.time) < o.day_gte) return false;
  if (o.roles_none?.includes(state.scenarioRole)) return false;
  const flags = new Set(state.flags[state.playerId] ?? []);
  if (o.flags_all && !o.flags_all.every((f) => flags.has(f))) return false;
  if (o.saga_ended) {
    const before = sagaState(state, o.saga_ended.id);
    if (!before || before.act !== "ended" || (o.saga_ended.ending && !o.saga_ended.ending.includes(before.ending ?? ""))) return false;
  }
  return roleStoriesFired(state, content) >= o.role_stories_gte;
}

/** 이야기 조건 when.saga가 맞는가 */
export function sagaConditionMet(state: GameState, content: Content, cond: NonNullable<StoryletContent["when"]["saga"]>): boolean {
  const g = sagaState(state, cond.id);
  if (!g || !content.sagas[cond.id]) return false;
  if (cond.acts && !cond.acts.includes(g.act)) return false;
  if (cond.ending && (g.act !== "ended" || !cond.ending.includes(g.ending ?? ""))) return false;
  if (!cond.acts && !cond.ending && !inProgress(g)) return false;
  if (cond.successor !== undefined) {
    const heir = g.engaged.length > 0 && !g.engaged.includes(state.playerId);
    if (heir !== cond.successor) return false;
  }
  if (cond.marked !== undefined) {
    const marked = !!g.marked && !state.characters[g.marked]?.dead;
    if (marked !== cond.marked) return false;
  }
  return true;
}

/** 등뼈 이야기가 기한 이틀 안이라 꼭 등급으로 오르는가 (공통 규칙 17이 묻는다) */
export function sagaSpineDue(state: GameState, s: StoryletContent, at: GameTime): boolean {
  const cond = s.when.saga;
  if (!cond?.spine) return false;
  const g = sagaState(state, cond.id);
  if (!g || !started(g) || (cond.acts && !cond.acts.includes(g.act))) return false;
  const due = deadlineOf(g);
  return due !== null && due - at <= SPINE_DUE_MINUTES;
}

/** 곁의 R인 사람 (배역 saga_marked) */
export function sagaMarked(state: GameState, content: Content): string | null {
  const a = activeSaga(state, content);
  const id = a?.g.marked;
  return id && !state.characters[id]?.dead ? id : null;
}

/** 곁의 R을 고른다: 함께 다니는 사람, 가까운 사이, 아끼거나 믿는 사람 (만난 사람만). 없으면 fallback 배역 */
function pickMarked(ctx: ToolContext, saga: SagaContent): string | null {
  const state = ctx.store.getState();
  const me = state.playerId;
  const alive = (id: string) => !!state.characters[id] && !state.characters[id]!.dead && !state.characters[id]!.away && id !== me;
  const fixed = new Set(Object.values(saga.cast));
  const close = new Set<string>([
    ...activeCompanions(state),
    ...tiesOf(state, ctx.content, me).filter((t) => CLOSE_TIES.has(t.kind)).map((t) => t.other),
    ...Object.keys(state.relations)
      .filter((id) => hasMet(state, me, id))
      .filter((id) => {
        const r = state.relations[id]?.[me];
        return !!r && (r.trust >= CLOSE_REGARD || r.affection >= CLOSE_REGARD);
      }),
  ]);
  const candidates = [...close].filter((id) => alive(id) && !fixed.has(id) && !heldOf(state.characters[id])).sort();
  if (candidates.length) return candidates[Math.floor(ctx.rng() * candidates.length)]!;
  const fallback = saga.mark?.fallback ? saga.cast[saga.mark.fallback] : undefined;
  return fallback && alive(fallback) ? fallback : null;
}

/** 막에 들어설 때: 곁의 R을 고르는 막이거나 그 뒤인데 곁의 R이 없거나 죽었으면 다시 고른다 */
function markOnEntry(ctx: ToolContext, saga: SagaContent, act: string): void {
  if (!saga.mark) return;
  const order = saga.acts.map((a) => a.id);
  if (order.indexOf(act) < order.indexOf(saga.mark.at)) return;
  const g = sagaState(ctx.store.getState(), saga.id)!;
  if (g.marked && !ctx.store.getState().characters[g.marked]?.dead) return;
  ctx.store.append({ type: "saga_marked", sagaId: saga.id, characterId: pickMarked(ctx, saga) });
}

/** 떠나 있던 사람이 도시에 들어온다 (문이 열릴 때·막이 시작될 때) */
function arrive(ctx: ToolContext, saga: SagaContent, keys: readonly string[]): void {
  const state = ctx.store.getState();
  const g = sagaState(state, saga.id);
  if (!g) return;
  const cast = sagaCast(saga, g);
  for (const key of keys) {
    const c = cast[key] ? state.characters[cast[key]!] : undefined;
    if (c && c.away && !c.dead) ctx.store.append({ type: "npc_arrived", npcId: c.id });
  }
}

/** 막을 넘긴다 (이야기 효과 saga_advance, 세계 쪽 사건). GM에게 알릴 줄 */
export function advanceSaga(ctx: ToolContext, id: string, to: string, options: { rush?: boolean; lapsed?: boolean } = {}): string | null {
  const saga = ctx.content.sagas[id];
  const g = sagaState(ctx.store.getState(), id);
  const act = saga ? actOf(saga, to) : undefined;
  if (!saga || !g || !act || !inProgress(g) || g.act === to) return null;
  ctx.store.append({ type: "saga_advanced", sagaId: id, act: to, days: act.days * (options.rush ? 0.5 : 1), lapsed: !!options.lapsed });
  ctx.store.append({ type: "saga_noted", sagaId: id, text: act.line, zone: null });
  arrive(ctx, saga, act.arrive);
  markOnEntry(ctx, saga, to);
  return `큰 이야기 「${saga.title}」의 「${act.title}」`;
}

/** 결말로 끝낸다 (이야기 효과 saga_end, 마지막 막의 기한). 결말의 효과를 적용하고 GM에게 알릴 줄 */
export function endSaga(ctx: ToolContext, apply: SagaEffectApplier, id: string, endingId: string, options: { lapsed?: boolean } = {}): { line: string | null; displays: ToolDisplayEvent[] } {
  const saga = ctx.content.sagas[id];
  const g = sagaState(ctx.store.getState(), id);
  const ending = saga?.endings.find((e) => e.id === endingId);
  if (!saga || !g || !ending || !inProgress(g)) return { line: null, displays: [] };
  const cast = sagaCast(saga, g);
  ctx.store.append({ type: "saga_ended", sagaId: id, ending: endingId, lapsed: !!options.lapsed });
  const displays: ToolDisplayEvent[] = [];
  const lines: string[] = [];
  for (const effect of ending.effects) {
    const out = apply(effect, cast, saga.title);
    if (out.line) lines.push(out.line);
    if (out.display) displays.push(out.display);
    if (out.displays) displays.push(...out.displays);
  }
  return { line: `(큰 이야기 「${saga.title}」가 끝났다: ${ending.title}. 이 순간을 장면의 무게 중심으로 연출한다. 게임은 이어진다)${lines.length ? ` ${lines.join(" ")}` : ""}`, displays };
}

/** 실마리 한 줄 (이야기 효과 saga_note): 진행 중인 큰 이야기에 */
export function noteSaga(ctx: ToolContext, text: string, zone: string | null): string | null {
  const a = activeSaga(ctx.store.getState(), ctx.content);
  if (!a) return null;
  ctx.store.append({ type: "saga_noted", sagaId: a.saga.id, text, zone });
  return text;
}

/** 곁의 R을 이 사람으로 (이야기 효과 saga_mark) */
export function markSaga(ctx: ToolContext, characterId: string): void {
  const a = activeSaga(ctx.store.getState(), ctx.content);
  if (a) ctx.store.append({ type: "saga_marked", sagaId: a.saga.id, characterId });
}

/** 큰 이야기의 이야기가 열렸다: 이 주인공이 발을 들였다 (계승자 이야기는 이것으로 가른다) */
export function engageSaga(ctx: ToolContext, s: StoryletContent): void {
  const id = s.when.saga?.id;
  const state = ctx.store.getState();
  if (!id || !sagaState(state, id) || s.when.saga?.successor) return;
  if (!sagaState(state, id)!.engaged.includes(state.playerId)) ctx.store.append({ type: "saga_engaged", sagaId: id, characterId: state.playerId });
}

/** 큰 이야기의 이야기가 끝났다: GM이 이어서 서술하도록 지난 장면 한 줄 */
export function recordSagaScene(ctx: ToolContext, s: StoryletContent, choiceLabel: string): void {
  const id = s.when.saga?.id;
  if (!id || !sagaState(ctx.store.getState(), id)) return;
  ctx.store.append({ type: "saga_scene", sagaId: id, line: `${dayOf(ctx.store.getState().time)}일차 「${s.title}」: ${choiceLabel}` });
}

/** 기한을 넘긴 막: 세계 쪽 사건 (파트 4) */
function lapse(ctx: ToolContext, apply: SagaEffectApplier, saga: SagaContent): ToolDisplayEvent[] {
  const g = sagaState(ctx.store.getState(), saga.id)!;
  const act = actOf(saga, g.act);
  if (!act) return [];
  const cast = sagaCast(saga, g);
  const displays: ToolDisplayEvent[] = [];
  for (const effect of act.lapse.effects) {
    const out = apply(effect, cast, saga.title);
    if (out.display) displays.push(out.display);
    if (out.displays) displays.push(...out.displays);
  }
  displays.push(...hearNews(ctx, { fact: act.lapse.news, factions: [], near: true, always: true, once: true }));
  if (act.lapse.ending || !act.next) {
    const ending = act.lapse.ending ?? saga.endings.at(-1)!.id;
    const done = endSaga(ctx, apply, saga.id, ending, { lapsed: true });
    displays.push(...done.displays);
    if (done.line) displays.push({ type: "belief", fact: act.lapse.news, sourceLabel: "큰 이야기", note: done.line });
    return displays;
  }
  advanceSaga(ctx, saga.id, act.next, { lapsed: true });
  if (act.lapse.note) ctx.store.append({ type: "saga_noted", sagaId: saga.id, text: act.lapse.note, zone: null });
  return displays;
}

/** 플래그 실마리 표: 새로 생긴 플래그의 실마리 (기존 줄기의 이야기를 고치지 않고 다음 길을 보인다) */
function flagNotes(ctx: ToolContext, saga: SagaContent): void {
  const state = ctx.store.getState();
  const g = sagaState(state, saga.id)!;
  const flags = new Set(state.flags[state.playerId] ?? []);
  for (const n of saga.notes) {
    if (!flags.has(n.flag) || g.notedFlags.includes(n.flag) || (n.acts && !n.acts.includes(g.act))) continue;
    ctx.store.append({ type: "saga_noted", sagaId: saga.id, text: n.text, zone: n.zone ?? null, flag: n.flag });
  }
}

/** 시간이 흐른 뒤마다 (runAfterTimeAdvance): 문 열기, 시계, 플래그 실마리. 화면·GM에 알릴 것 */
export function runSagas(ctx: ToolContext, apply: SagaEffectApplier): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return [];
  const displays: ToolDisplayEvent[] = [];
  for (const saga of Object.values(ctx.content.sagas).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!doorOpens(ctx.store.getState(), ctx.content, saga)) continue;
    ctx.store.append({ type: "saga_opened", sagaId: saga.id });
    arrive(ctx, saga, saga.arrive);
  }
  const a = activeSaga(ctx.store.getState(), ctx.content);
  if (!a) return displays;
  // 오래 건너뛰었으면 넘긴 막이 여럿일 수 있다
  for (let i = 0; i < a.saga.acts.length; i++) {
    const g = sagaState(ctx.store.getState(), a.saga.id)!;
    const due = deadlineOf(g);
    if (!started(g) || due === null || ctx.store.getState().time < due) break;
    displays.push(...lapse(ctx, apply, a.saga));
  }
  if (started(sagaState(ctx.store.getState(), a.saga.id)!)) flagNotes(ctx, a.saga);
  return displays;
}

/** 상인의 귀한 물건 확률 배율: 끝난 큰 이야기의 결말이 바꾼 것 */
export function sagaMarketFactor(state: GameState, content: Content, itemId: string): number {
  let factor = 1;
  for (const [id, g] of Object.entries(sagasOf(state))) {
    if (g.act !== "ended") continue;
    const m = content.sagas[id]?.endings.find((e) => e.id === g.ending)?.market?.[itemId];
    if (m !== undefined) factor *= m;
  }
  return factor;
}

/** 실마리 뒤에 붙일 구역 이름: 글에 이미 "→ 곳"이 있으면 붙이지 않는다 (PT42 떠돌이: "→ 가람항 북부두 → 가람항 북부두") */
function noteZoneName(content: Content, note: string | null, zone: string | null): string | null {
  if (!zone || note?.includes("→")) return null;
  return content.locations[zone]?.name ?? zone;
}

/** 퀘스트 줄 (상태 화면·?퀘스트): 진행 중인 큰 이야기 */
export function sagaQuest(state: GameState, content: Content): { key: string; title: string; detail: string; line: string | null; note: string | null; zone: string | null; steps: { text: string; met: boolean }[]; leftMinutes: number | null } | null {
  const a = activeSaga(state, content);
  if (!a) return null;
  const { saga, g } = a;
  const at = saga.acts.findIndex((x) => x.id === g.act);
  const due = deadlineOf(g);
  return {
    key: `saga_${saga.id}`,
    title: saga.title,
    detail: actOf(saga, g.act)?.title ?? "",
    // 막의 줄은 늘 보인다: 이야기의 실마리가 그 위에 쌓여도 막의 갈 곳·때가 남게 (PT42 수색대원: 2막 실마리가 이미 일어난 일만 말했다)
    line: g.note === actOf(saga, g.act)?.line ? null : (actOf(saga, g.act)?.line ?? null),
    note: g.note,
    zone: noteZoneName(content, g.note, g.noteZone),
    // 지난 막과 지금 막까지 (앞 막 제목은 숨긴다)
    steps: saga.acts.slice(0, at + 1).map((x, i) => ({ text: x.title, met: i < at })),
    leftMinutes: due === null ? null : due - state.time,
  };
}

/** GM 상태의 줄: 지금 막과 지침, 실마리, 지난 장면 (곁의 R은 주인공이 알게 될 때까지 싣지 않는다) */
export function describeSaga(state: GameState, content: Content): string[] {
  const a = activeSaga(state, content);
  if (!a) return [];
  const { saga, g } = a;
  const act = actOf(saga, g.act);
  const due = deadlineOf(g);
  const left = due === null ? "" : `, 기한까지 ${Math.max(0, Math.ceil((due - state.time) / MINUTES_PER_DAY))}일`;
  const lines = [
    `큰 이야기 「${saga.title}」 — ${act?.title ?? g.act}${left}. ${saga.summary}`,
    `이 막의 지침: ${act?.gm ?? ""}`,
    ...(act && g.note !== act.line ? [`이 막의 줄 (주인공이 들은 말): ${act.line}`] : []),
    ...(g.note ? [`실마리 (주인공이 들은 말): ${g.note}${noteZoneName(content, g.note, g.noteZone) ? ` → ${noteZoneName(content, g.note, g.noteZone)}` : ""}. 플레이어가 엉뚱한 때·곳에 가면 이 말로 이끈다`] : []),
    ...(g.scenes.length ? [`지난 큰 이야기 장면: ${g.scenes.join(" / ")} (이어서 서술한다)`] : []),
  ];
  if (g.engaged.length && !g.engaged.includes(state.playerId)) lines.push("앞 주인공이 겪던 큰 이야기다. 지금 주인공은 아직 모른다 (다시 잇는 이야기가 실마리를 건넨다)");
  return lines;
}

/** 연대기 줄: 끝난 큰 이야기 */
export function sagaChronicle(state: GameState, content: Content): string[] {
  return Object.entries(sagasOf(state))
    .filter(([, g]) => g.act === "ended")
    .map(([id, g]) => {
      const saga = content.sagas[id];
      const ending = saga?.endings.find((e) => e.id === g.ending);
      const text = g.endedByLapse ? (ending?.lapsed_chronicle ?? ending?.chronicle) : ending?.chronicle;
      return `큰 이야기: ${saga?.title ?? id} — ${text ?? g.ending}`;
    });
}

/** 치트 (~saga): 문을 조건 없이 열고, 막을 정하거나 결말로 끝낸다. 진행 중인 다른 큰 이야기는 건드리지 않는다 */
export function cheatSaga(ctx: ToolContext, apply: SagaEffectApplier, id: string, act: string | null, ending: string | null): { ok: boolean; text: string } {
  const saga = ctx.content.sagas[id]!;
  if (!sagaState(ctx.store.getState(), id)) {
    ctx.store.append({ type: "saga_opened", sagaId: id });
    arrive(ctx, saga, saga.arrive);
  }
  if (!act) return { ok: true, text: `큰 이야기 「${saga.title}」의 문이 열렸다 (시작 사건을 기다린다)` };
  if (act === "end") {
    if (!ending || !saga.endings.some((e) => e.id === ending)) return { ok: false, text: `결말: ${saga.endings.map((e) => e.id).join(", ")}` };
    const g = sagaState(ctx.store.getState(), id)!;
    if (g.act === "open") ctx.store.append({ type: "saga_advanced", sagaId: id, act: saga.acts[0]!.id, days: saga.acts[0]!.days, lapsed: false });
    return { ok: true, text: endSaga(ctx, apply, id, ending).line ?? "이미 끝난 큰 이야기다" };
  }
  if (!actOf(saga, act)) return { ok: false, text: `막: ${saga.acts.map((a) => a.id).join(", ")}` };
  return { ok: true, text: advanceSaga(ctx, id, act) ?? "이미 그 막이거나 끝난 큰 이야기다" };
}

/** 곁의 R을 부르는 말 (GM 지침 문장 등) */
export function sagaMarkedName(state: GameState, content: Content): string | null {
  const id = sagaMarked(state, content);
  return id ? playerCalls(state, content, id) : null;
}
