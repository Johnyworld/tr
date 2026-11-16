import { activeCompanions } from "../game/companions.ts";
import type { GameState } from "../game/state.ts";
import { segmentOf } from "../rules/time.ts";
import { incapacitatingSymptom, trackOf } from "../scenario/scenario.ts";
import { changeCondition, shakeNerves } from "./body.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 공포 (기획서 4.5.1, 12-95): 그 자리에서 오르고 몇 시간 안에 빠지는 단기 상태. 판정 보정만 준다.
 * - 오르는 양은 코드가 정한다: 계기의 단계 + 어둠 - 동행 ± 트레잇 - 둔감해짐 (+ 마음이 무너져 있으면 1), 능력으로 한 단계 버틴다
 * - 공포를 부른 것을 마주할 때마다 노출이 쌓인다 (fear_exposed). 문턱을 넘을 때마다 덜 오른다
 * - 공포를 부른 것이 장면에 없으면 시간마다 가라앉고, 자고 나면 평정
 * - 주인공만 계산한다 (NPC는 다음 단계)
 */

export type FearResult = { lines: string[]; displays: ToolDisplayEvent[] };

const EMPTY: FearResult = { lines: [], displays: [] };

const rules = (ctx: ToolContext) => ctx.content.scenario.body?.fear;

function levelIndex(ctx: ToolContext, state: GameState, id: string, trackId: string): number {
  const track = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, track.levels.findIndex((l) => l.id === state.characters[id]?.conditions[trackId]));
}

/** GM이 고르는 take_action.fright의 이름 */
export const FRIGHT_CAUSES = { startle: "깜짝 놀랐다", dread: "두려움에 압도됐다" } as const;

/**
 * 주인공의 공포가 오른다. base: 계기가 주는 단계. 버텼으면 그렇다고 알린다 (GM이 서술에 쓴다)
 */
export function frighten(ctx: ToolContext, base: number, cause: string, tag?: string): FearResult {
  const f = rules(ctx);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!f || !me || me.dead || base <= 0) return EMPTY;
  if (incapacitatingSymptom(ctx.content.scenario, me)) return EMPTY; // 정신을 잃은 사람은 겁먹지 않는다

  const exposure = state.fearExposure[me.id] ?? 0;
  let steps = base;
  if (f.dark.segments.includes(segmentOf(state.time))) steps += f.dark.steps;
  if (activeCompanions(state).length > 0) steps -= f.companion;
  steps += traitsOf(ctx.content, me).reduce((n, t) => n + (t.effects.fear ?? 0), 0);
  steps -= f.desensitize.filter((n) => exposure >= n).length;
  // 아는 것은 덜 무섭다 (감염체 지식 → 감염체)
  if (tag && f.lore.some((l) => l.tag === tag && (me.skills[l.skill] ?? -9) >= l.min)) steps -= 1;
  const nerves = ctx.content.scenario.body?.nerves;
  if (f.nerves_from && nerves) {
    const from = trackOf(ctx.content.scenario, nerves.track).levels.findIndex((l) => l.id === f.nerves_from);
    if (from >= 0 && levelIndex(ctx, state, me.id, nerves.track) >= from) steps += 1;
  }
  const hold = Math.min(0.8, Math.max(0, f.resist.per_point * (me.stats[f.resist.ability] ?? 0)));
  if (steps > 0 && ctx.rng() < hold) steps -= 1;
  ctx.store.append({ type: "fear_exposed", characterId: me.id });

  if (steps <= 0) return { lines: [`${me.name}은(는) 두려움을 눌러 참았다 (${cause}). 공포가 오르지 않았다.`], displays: [] };
  const c = changeCondition(ctx, me.id, f.track, steps, "fear", cause);
  if (!c?.display) return EMPTY;
  const out: FearResult = { lines: [c.line], displays: [c.display] };
  // 공황에 이르면 마음에 상처가 남을 수 있다
  const track = trackOf(ctx.content.scenario, f.track);
  if (levelIndex(ctx, ctx.store.getState(), me.id, f.track) === track.levels.length - 1 && ctx.rng() < f.panic_nerves) {
    const shaken = shakeNerves(ctx, 1, "공황에 빠졌다");
    if (shaken?.display) {
      out.lines.push(shaken.line);
      out.displays.push(shaken.display);
    }
  }
  out.lines.push("떨리는 손, 좁아지는 시야로 연출한다. 플레이어 대신 도망치거나 얼어붙게 하지 않는다 (판정만 어려워진다).");
  return out;
}

/** 공포를 부르는 것이 지금 장면에 있는가: 전투 중, 공포를 부른 이야기가 진행 중, 무서운 것이 장면에 있음 */
export function fearSourcePresent(ctx: ToolContext, state: GameState = ctx.store.getState()): boolean {
  if (state.battle) return true;
  if (state.activeStorylet && (ctx.content.storylets[state.activeStorylet.id]?.fright ?? 0) > 0) return true;
  return state.scene.present.some((id) => fearsomeOf(ctx, state, id) > 0);
}

function fearsomeOf(ctx: ToolContext, state: GameState, id: string): number {
  const c = state.characters[id];
  if (!c || c.dead) return 0;
  const template = c.extra?.template;
  return template ? (ctx.content.extras[template]?.fearsome ?? 0) : 0;
}

/** 시간이 흐른 뒤: 공포를 부른 것이 장면에 없으면 decay_hours마다 한 단계 가라앉는다 */
export function runFearDecay(ctx: ToolContext): ToolDisplayEvent[] {
  const f = rules(ctx);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!f || !me || me.dead) return [];
  if (levelIndex(ctx, state, me.id, f.track) <= 0 || fearSourcePresent(ctx, state)) return [];
  const since = state.recovery.trackAt[`${me.id}:${f.track}`] ?? state.time;
  const times = Math.floor((state.time - since) / (f.decay_hours * 60));
  if (times <= 0) return [];
  const c = changeCondition(ctx, me.id, f.track, -times, "fear", "위협에서 벗어나 숨을 골랐다");
  return c?.display ? [c.display] : [];
}

/** 자고 나면 평정 */
export function calmAfterSleep(ctx: ToolContext): FearResult {
  const f = rules(ctx);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!f || !me || me.dead) return EMPTY;
  const index = levelIndex(ctx, state, me.id, f.track);
  if (index <= 0) return EMPTY;
  const c = changeCondition(ctx, me.id, f.track, -index, "fear", "자고 나니 진정됐다");
  return c?.display ? { lines: [c.line], displays: [c.display] } : EMPTY;
}

/** tool 하나 전후의 장면. 무엇이 새로 나타났는지 비교한다 */
export type FearWatch = { present: ReadonlySet<string>; storylet: string | null; battle: boolean };

export function watchFear(state: GameState): FearWatch {
  return { present: new Set(state.scene.present), storylet: state.activeStorylet?.id ?? null, battle: !!state.battle };
}

/**
 * tool이 끝난 뒤 새로 나타난 공포의 계기: 무서운 것이 장면에 들어옴(엑스트라 fearsome, 셋 이상이면 +1),
 * 공포를 부르는 이야기가 열림(fright), 무리 전투가 붙음. 한꺼번에 일어나면 가장 큰 것 하나로 (겹쳐 세지 않는다)
 */
export function fearAfterTool(ctx: ToolContext, before: FearWatch): FearResult {
  const f = rules(ctx);
  if (!f) return EMPTY;
  const state = ctx.store.getState();
  const triggers: { steps: number; cause: string; tag?: string }[] = [];

  const arrivals = state.scene.present.filter((id) => !before.present.has(id) && fearsomeOf(ctx, state, id) > 0);
  if (arrivals.length) {
    const steps = Math.max(...arrivals.map((id) => fearsomeOf(ctx, state, id))) + (arrivals.length >= 3 ? 1 : 0);
    const names = arrivals.map((id) => state.characters[id]!.name);
    const scariest = arrivals.reduce((a, b) => (fearsomeOf(ctx, state, b) > fearsomeOf(ctx, state, a) ? b : a));
    const tag = ctx.content.extras[state.characters[scariest]!.extra?.template ?? ""]?.fright_tag;
    triggers.push({ tag, steps, cause: `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}` : ""}이(가) 나타났다` });
  }
  const storylet = state.activeStorylet?.id;
  if (storylet && storylet !== before.storylet) {
    const s = ctx.content.storylets[storylet];
    if (s?.fright) triggers.push({ steps: s.fright, cause: s.title, tag: s.fright_tag });
  }
  if (state.battle && !before.battle && f.battle > 0) triggers.push({ steps: f.battle, cause: "전투가 붙었다" });

  if (!triggers.length) return EMPTY;
  const top = triggers.reduce((a, b) => (b.steps > a.steps ? b : a));
  return frighten(ctx, top.steps, top.cause, top.tag);
}
