import { josa } from "../text.ts";
import { campFactor, watchedHere } from "./facilities.ts";
import type { Content, StoryletContent } from "../content/schemas.ts";
import { activeCompanions, bondOf } from "../game/companions.ts";
import { infestationOf } from "../game/infestation.ts";
import { kindOf } from "../game/kinds.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { segmentOf, type Activity, type GameTime } from "../rules/time.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import { fillStorylet, pickCast, pickStorylet, roadStorylets, storyletVars } from "../story/storylets.ts";
import { welcomedAsGuest } from "./climate.ts";
import { fireStorylet, storySetup, storyTitle, maskUnknownNames } from "./storyletTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 야영과 불침번 (기획서 4.5.6, 12-148).
 * 지켜 주는 지붕이 없는 곳에서 자거나 쉬면, 그 구역의 위험만큼 밤 사이 무언가가 다가온다 (태그 camp 이야기).
 * 깨어 있거나 보초를 설 동행이 있으면 다가오는 것을 미리 알고(camp_watched: true), 아무도 지키지 않고 잠들었으면 늦게 안다(false).
 * 모닥불은 따뜻하지만 불빛이 멀리서 보여 더 자주 찾아온다
 */

/** 야영의 이야기가 끼어들 수 있는 활동: 한자리에서 오래 머무는 것 */
const CAMP_ACTIVITIES: readonly string[] = ["sleep", "rest", "wait", "guard_duty"];

/** 끼어들기의 갈래 (advanceTime이 이것을 보고 야영의 이야기를 연다) */
export const CAMP_INTERRUPT = "야영지에 무언가 다가왔다";

export type CampSite = {
  /** 위험과 감염체 압력 중 높은 쪽 (0~3) */
  danger: number;
  /** 우리 무리 땅인가 (우리 순찰이 돈다) */
  ownLand: boolean;
};

/**
 * 지금 자리가 야영인가. 우리 무리 거점, 재워 주는 다른 무리 거점(12-121), 피난처(sanctuary)는 지켜 주는 지붕이다.
 * 갇혀 있으면 야영이 아니다 (갇힌 동안의 이야기가 따로 있다)
 */
export function campSite(content: Content, state: GameState): CampSite | null {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!content.scenario.camp || !me || me.dead || me.captive || !zone) return null;
  const location = content.locations[zone];
  if (!location) return null;
  const owner = state.zones[zone]?.owner ?? null;
  // 내 거처도 우리 땅처럼 덜 위험하다 (12-195: 거처로 정한 마트도 밤마다 들개·매복이 왔다). 시설(바리케이드·경보줄)은 그 위에 더한다
  const ownLand = (!!me.factionId && owner === me.factionId) || state.homes?.[me.id] === zone;
  if (location.sanctuary) return null;
  if (location.kind === "base" && (ownLand || welcomedAsGuest(content, state))) return null;
  return { danger: Math.min(3, Math.max(location.danger ?? 0, infestationOf(content, state, zone))), ownLand };
}

/** 보초를 설 수 있는 동행: 깨어 있는 사람·동물 (끌고 가는 포로와 감염체는 빠진다) */
export function campWatchers(content: Content, state: GameState): string[] {
  return activeCompanions(state).filter((id) => {
    const c = state.characters[id];
    if (!c || kindOf(content, c) === "infected") return false;
    if (bondOf(state, content, id)?.kind === "prisoner") return false;
    return !incapacitatingSymptom(content.scenario, c);
  });
}

/** 지쳐서·아파서 깊이 잠드는가 (12-188, camp.deep_sleep): 어느 트랙이든 정한 단계 이상이면. 화면에 붙일 이유(그 단계 이름)를 돌려준다 */
export function deepSleepReason(content: Content, state: GameState, id: string = state.playerId): string | null {
  const rules = content.scenario.camp?.deep_sleep ?? {};
  const c = state.characters[id];
  if (!c) return null;
  for (const [track, from] of Object.entries(rules)) {
    const t = content.scenario.condition_tracks.find((x) => x.id === track);
    if (!t) continue;
    const at = t.levels.findIndex((l) => l.id === c.conditions[track]);
    const min = t.levels.findIndex((l) => l.id === from);
    if (at >= 0 && min >= 0 && at >= min) {
      const level = t.levels[at]!;
      return level.label ?? content.scenario.symptoms?.find((s) => s.id === level.symptoms?.[0])?.label ?? t.label;
    }
  }
  return null;
}

/** 지켜보는 밤인가: 깨어 있는 활동이거나 보초를 설 동행이 있다. 깊이 잠들었으면 보초가 있어도 늦게 안다 (12-188) */
export function campWatched(content: Content, state: GameState, activity: Activity | string, deep: string | null = activity === "sleep" ? deepSleepReason(content, state) : null): boolean {
  if (activity !== "sleep") return true;
  if (deep) return false;
  // 거처의 경보줄 (12-167): 잠들어도 다가오는 것을 미리 안다
  return campWatchers(content, state).length > 0 || watchedHere(content, state);
}

/** 시간당 확률 */
export function campChance(content: Content, state: GameState, site: CampSite, at: GameTime): number {
  const camp = content.scenario.camp!;
  const fire = !!state.playerZone && (state.fires[state.playerZone] ?? 0) > at;
  // 바리케이드 (12-167)
  return (camp.chance[site.danger] ?? 0) * (fire ? camp.fire : 1) * (site.ownLand ? camp.own_land : 1) * campFactor(content, state, state.playerZone);
}

/** 지금 열 수 있는 야영의 이야기 */
export function campStorylets(content: Content, state: GameState, watched: boolean, at: GameTime): StoryletContent[] {
  const camp = content.scenario.camp;
  if (!camp) return [];
  return roadStorylets(state, content, camp.tag, at).filter((s) => s.when.camp_watched === undefined || s.when.camp_watched === watched);
}

/** 빨리감기 중 야영지에 무언가 다가오면 멈춘다 */
export function createCampCheck(content: Content, activity: Activity, deep: string | null = null): InterruptCheck {
  return ({ state, from, to, rng }) => {
    if (!CAMP_ACTIVITIES.includes(activity) || state.activeStorylet || state.battle) return null;
    const me = state.characters[state.playerId];
    if (!me || incapacitatingSymptom(content.scenario, me)) return null;
    const site = campSite(content, state);
    if (!site) return null;
    const chance = campChance(content, state, site, from) * ((to - from) / 60);
    if (chance <= 0 || rng() >= chance) return null;
    const at = from + Math.max(1, Math.ceil(rng() * (to - from)));
    if (campStorylets(content, state, campWatched(content, state, activity, deep), at).length === 0) return null;
    return { kind: "storylet", detail: CAMP_INTERRUPT, at };
  };
}

/** 끊긴 시각에 야영의 이야기 하나를 연다. 연 이야기의 제목과 GM에게 줄 말 */
export function runCampEvent(ctx: ToolContext, activity: Activity, deep: string | null = null): { displays: ToolDisplayEvent[]; line: string | null } {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const watched = campWatched(content, state, activity, deep);
  const storylet = pickStorylet(campStorylets(content, state, watched, state.time), rng);
  if (!storylet) return { displays: [], line: null };
  const displays = fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!);
  const now = store.getState();
  const cast = now.activeStorylet?.cast ?? {};
  displays.push({ type: "storylet", event: "started", title: storyTitle(now, content, storylet), detail: maskUnknownNames(now, content, fillStorylet(storySetup(now, storylet), storyletVars(now, content, cast))) });
  const watchers = campWatchers(content, state).map((id) => playerCalls(store.getState(), content, id));
  const who =
    activity !== "sleep"
      ? "깨어 있었으니 다가오는 것을 먼저 알아챘다"
      : deep
        ? `${deep} 탓에 깊이 잠들어 있었다. ${watchers.length ? `보초를 서던 ${josa(watchers.join("·"), "이/가")} 흔들어 깨웠지만 몸이 무거워 ` : ""}이미 가까이 와서야 깼다`
        : watchers.length
          ? `보초를 서던 ${watchers.join("·")}의 기척에 깼다. 다가오는 것을 먼저 알아챘다`
          : "아무도 지키지 않고 잠들어 있었다. 이미 가까이 와서야 깼다";
  return {
    displays,
    line: `야영지에 일이 생겼다: "${storyTitle(now, content, storylet)}". ${who}. 그 장면으로 연출하라 (상태의 '진행 중인 이야기').`,
  };
}

/**
 * GM 상태의 한 줄: 저녁·밤·새벽에 지켜 주는 지붕이 없는 곳에 있으면 여기서 자는 것이 야영임을 알린다.
 * 숫자(확률·위험)는 주지 않는다
 */
export function describeCamp(content: Content, state: GameState): string | null {
  if (!["evening", "night", "dawn"].includes(segmentOf(state.time))) return null;
  const site = campSite(content, state);
  if (!site) return null;
  const watchers = campWatchers(content, state).map((id) => playerCalls(state, content, id));
  const fire = !!state.playerZone && (state.fires[state.playerZone] ?? 0) > state.time;
  const deep = deepSleepReason(content, state);
  return (
    `잠자리: 여기서 자면 야영이다 (지켜 주는 담과 순찰이 없다). ` +
    (deep ? `${deep} 탓에 지금 자면 깊이 잠든다 (보초가 있어도 다가오는 것을 늦게 안다). ` : "") +
    (watchers.length ? `${josa(watchers.join("·"), "이/가")} 번갈아 보초를 설 수 있다. ` : "혼자 잠들면 아무도 지키지 않는다 (보초를 서려면 activity guard_duty, 그동안 잠은 못 잔다). ") +
    (fire ? "모닥불이 따뜻하지만 불빛과 연기가 멀리서 보인다. " : "") +
    (site.ownLand ? "우리 땅이라 우리 순찰이 돈다." : "무엇이 다가올지는 시스템이 정한다.")
  );
}
