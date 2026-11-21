import { baseInfestation, infestationOf } from "../game/infestation.ts";
import { josa } from "../text.ts";
import { activeCompanions } from "../game/companions.ts";
import type { GameState } from "../game/state.ts";
import { segmentOf } from "../rules/time.ts";
import { incapacitatingSymptom, trackOf } from "../scenario/scenario.ts";
import { changeCondition, shakeNerves, steadyRoll } from "./body.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 공포 (기획서 4.5.1, 12-95): 그 자리에서 오르고 몇 시간 안에 빠지는 단기 상태. 판정 보정만 준다.
 * - 오르는 양은 코드가 정한다: 계기의 단계 + 어둠 - 동행 ± 트레잇 (+ 마음이 무너져 있으면 1). 주인공이 마음 다잡기를 굴려 버틴다 (12-220)
 * - 겪을수록 둔감해지는 것과 아는 것(지식 스킬)이 덜 무서운 것은 12-185에 뺐다
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

/** 공포의 태그 (공포증이 무서워하는 것). GM이 즉흥 장면에 고를 수 있는 값 */
export function fearTagIds(s: import("../scenario/schema.ts").Scenario): string[] {
  return [...new Set(s.traits.flatMap((t) => t.effects?.phobia ?? []))].sort();
}

/** GM이 고르는 take_action.fright의 이름 */
export const FRIGHT_CAUSES = { startle: "깜짝 놀랐다", dread: "두려움에 압도됐다" } as const;

/**
 * 주인공의 공포가 오른다. base: 계기가 주는 단계. 버텼으면 그렇다고 알린다 (GM이 서술에 쓴다)
 */
/** 같은 순간으로 치는 시간 (분): 이 안에 오른 공포는 같은 위협의 것이다 */
export const FEAR_SAME_MOMENT = 10;

export function frighten(ctx: ToolContext, base: number, cause: string, tags: readonly string[] = []): FearResult {
  const f = rules(ctx);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!f || !me || me.dead) return EMPTY;
  if (incapacitatingSymptom(ctx.content.scenario, me)) return EMPTY; // 정신을 잃은 사람은 겁먹지 않는다
  const dark = f.dark.segments.includes(segmentOf(state.time));
  // 공포증 (12-103): 무서워하는 것이 계기에 있으면 한 단계 더. 보통 사람에게 무섭지 않은 것(base 0)이어도 온다
  const fears = new Set(traitsOf(ctx.content, me).flatMap((t) => t.effects.phobia ?? []));
  const phobia = [...tags, ...(dark ? ["dark"] : [])].some((t) => fears.has(t));
  if (base <= 0 && !phobia) return EMPTY;
  // 공포는 한 위협에 한 번 (12-241, 플레이 테스트 13: 감염체를 들여 오른 공포에 같은 턴 GM의 fright가 한 단계를 더 얹었다):
  // 같은 순간(FEAR_SAME_MOMENT분 안)에 이미 올랐으면 더 오르지 않는다. 무서운 것이 들어올 때·GM이 고를 때·인물 쪽 일 모두 여기를 거친다
  const raisedAt = state.recovery.trackAt?.[`${me.id}:${trackOf(ctx.content.scenario, f.track).id}`];
  if (raisedAt !== undefined && state.time - raisedAt <= FEAR_SAME_MOMENT && levelIndex(ctx, state, me.id, f.track) > 0) {
    return { lines: [`공포는 이 위협으로 이미 올랐다 (${cause}: 같은 순간에 다시 오르지 않는다).`], displays: [] };
  }

  let steps = base + (phobia ? 1 : 0);
  if (dark) steps += f.dark.steps;
  if (activeCompanions(state).length > 0) steps -= f.companion;
  steps += traitsOf(ctx.content, me).reduce((n, t) => n + (t.effects.fear ?? 0), 0);
  const nerves = ctx.content.scenario.body?.nerves;
  if (f.nerves_from && nerves) {
    const from = trackOf(ctx.content.scenario, nerves.track).levels.findIndex((l) => l.id === f.nerves_from);
    if (from >= 0 && levelIndex(ctx, state, me.id, nerves.track) >= from) steps += 1;
  }
  if (f.max_steps) steps = Math.min(steps, f.max_steps);
  // 이미 공황이면 더 오를 데가 없다 (굴리지 않는다)
  const track = trackOf(ctx.content.scenario, f.track);
  if (steps <= 0 || levelIndex(ctx, state, me.id, f.track) >= track.levels.length - 1) return EMPTY;
  // 마음 다잡기 (12-220): 성공이면 오르지 않고, 대가 있는 성공이면 한 단계 덜
  const held = steadyRoll(ctx, steps, cause);
  if (held.steps <= 0) return { lines: [`겁날 일이었다 (${cause}). ${josa(me.name, "은/는")} 두려움을 눌러 참았다. 공포가 오르지 않았다.`], displays: held.displays };
  const c = changeCondition(ctx, me.id, f.track, held.steps, "fear", cause);
  if (!c?.display) return { lines: [], displays: held.displays };
  const out: FearResult = { lines: [c.line], displays: [...held.displays, c.display] };
  // 다잡지 못하고 공황에 이르면 마음에 상처가 남는다 (굴리지 않는다)
  if (held.outcome !== "partial" && levelIndex(ctx, ctx.store.getState(), me.id, f.track) === track.levels.length - 1) {
    const shaken = shakeNerves(ctx, 1, "공황에 빠졌다", false);
    out.lines.push(...shaken.lines);
    out.displays.push(...shaken.displays);
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
  // 감염체가 몰려든 구역에서는 가라앉지 않는다 (플레이 테스트 13: 몰려든 강변에 들어서며 "숨을 골랐다")
  const zone = state.playerZone;
  if (zone && infestationOf(ctx.content, state, zone) > baseInfestation(ctx.content, zone)) return [];
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
  const triggers: { steps: number; cause: string; tags: string[] }[] = [];

  const tagsOf = (id: string) => ctx.content.extras[state.characters[id]?.extra?.template ?? ""]?.fright_tags ?? [];
  const arrivals = state.scene.present.filter((id) => !before.present.has(id) && !state.characters[id]?.dead && (fearsomeOf(ctx, state, id) > 0 || tagsOf(id).length > 0));
  if (arrivals.length) {
    const scary = arrivals.filter((id) => fearsomeOf(ctx, state, id) > 0);
    const steps = scary.length ? Math.max(...scary.map((id) => fearsomeOf(ctx, state, id))) + (scary.length >= 3 ? 1 : 0) : 0;
    const names = arrivals.map((id) => state.characters[id]!.name);
    const tags = [...new Set(arrivals.flatMap(tagsOf))];
    // 조사는 이름 전체에 붙인다 (빈 문자열에 붙여 "감염체이(가)"가 됐다, 플레이 테스트 8)
    const who = `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}명` : ""}`;
    triggers.push({ tags, steps, cause: `${josa(who, "이/가")} 나타났다` });
  }
  const storylet = state.activeStorylet?.id;
  if (storylet && storylet !== before.storylet) {
    const s = ctx.content.storylets[storylet];
    if (s && ((s.fright ?? 0) > 0 || (s.fright_tags ?? []).length > 0)) triggers.push({ steps: s.fright ?? 0, cause: s.title, tags: s.fright_tags ?? [] });
  }
  if (state.battle && !before.battle && f.battle > 0) triggers.push({ steps: f.battle, cause: "전투가 붙었다", tags: [] });

  if (!triggers.length) return EMPTY;
  // 가장 큰 계기 하나로 세되, 태그는 모두 본다 (감염체 무리가 지하에서 나오면 infected와 enclosed 둘 다)
  const top = triggers.reduce((a, b) => (b.steps > a.steps ? b : a));
  return frighten(ctx, top.steps, top.cause, [...new Set(triggers.flatMap((t) => t.tags))]);
}
