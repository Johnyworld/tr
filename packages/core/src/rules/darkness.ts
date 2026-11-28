/**
 * 공통 규칙 27: 어둠 속 눈 (docs/design.md "공통 규칙", 12-366).
 *
 * 어두우면(`darkHere`) 주인공의 수색·부대 알아채기가 나빠지고 수색이 오래 걸린다. 불빛(`tool.light`, 손전등)이 있으면 지워지지만
 * 그 불빛이 남의 눈에 띈다(밤의 가림을 못 받는다). 트레잇: 어둠에 익숙함(adapted)은 둘 다 없고, 야맹증은 감점·시간이 더 크다.
 * 수치는 시나리오 `opposition.dark.sight`, 트레잇 `effects.dark`. 어둠의 효과를 쓰는 곳은 이 함수로만 읽는다.
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { traitsOf } from "../engine/traits.ts";
import { withBags } from "./bags.ts";
import { heatedHere } from "../engine/climate.ts";
import { darkHere, shelterAt } from "./place.ts";

export type Darkness = {
  /** 어두운가 (불 켠 지붕 아래가 아니고 어두운 시간대) */
  dark: boolean;
  /** 눈 스킬·부대 알아채기에 붙는 감점 (0 이상) */
  penalty: number;
  /** 수색 시간 배수 (1 이상) */
  searchTime: number;
  /** 불빛이 남의 눈에 띈다 (어둡고 불빛을 지녔고 어둠에 익숙하지 않을 때) */
  glare: boolean;
};

const NONE: Darkness = { dark: false, penalty: 0, searchTime: 1, glare: false };

/**
 * 어두운가: `darkHere`(불 켠 지붕 아래는 밝다)에 더해, 우리 쪽 거점 난방(불 땐 거처)·피난처 안도 밝다
 * (PT45: 기온 줄은 "불 땐 거처"인데 수색은 어둡게 셌다). 숨기의 어둠 보정과 어둠 공포도 이것으로 본다
 */
export function darkAround(state: GameState, content: Content, segments: Parameters<typeof darkHere>[2], at: number = state.time): boolean {
  if (!darkHere(state, content, segments, at)) return false;
  const zone = state.playerZone;
  const warmRoof = shelterAt(content, state, "rest").indoor && (heatedHere(content, state) || (!!zone && !!content.locations[zone]?.sanctuary));
  return !warmRoof;
}

/** 주인공이 지금(또는 at 시각에) 어둠에서 어떤지. 월드 팩에 어둠 속 눈 규칙이 없으면 늘 NONE */
export function darknessOf(state: GameState, content: Content, at: number = state.time): Darkness {
  const cfg = content.scenario.opposition?.dark;
  const sight = cfg?.sight;
  const me = state.characters[state.playerId];
  if (!cfg || !sight || !me || !darkAround(state, content, cfg.segments, at)) return NONE;
  const dark = traitsOf(content, me).flatMap((t) => (t.effects.dark ? [t.effects.dark] : []));
  if (dark.some((d) => d.adapted)) return { ...NONE, dark: true };
  const lit = Object.entries(withBags(state, me).inventory).some(([id, q]) => q > 0 && content.items[id]?.tool?.light);
  if (lit) return { dark: true, penalty: 0, searchTime: 1, glare: true };
  return {
    dark: true,
    penalty: Math.max(sight.penalty, ...dark.map((d) => d.penalty ?? 0)),
    searchTime: Math.max(sight.search_time, ...dark.map((d) => d.search_time ?? 1)),
    glare: false,
  };
}

/** 그 스킬이 어둠의 감점을 받는가 (수색) */
export const darkSightMove = (content: Content, move: string): boolean => !!content.scenario.opposition?.dark?.sight?.moves.includes(move);

/** 수색 시간(분)에 배수를 곱한다 (5분 단위로 올림) */
export const darkSearchMinutes = (minutes: number, d: Darkness): number => (d.searchTime > 1 ? Math.ceil((minutes * d.searchTime) / 5) * 5 : minutes);
