import { runMissionStartOfTurn } from "./missionTools.ts";
import { runSquadOrders } from "./command.ts";
import { runCompanions } from "./companionTools.ts";
import { spreadRumors } from "./reputationTools.ts";
import { runWarDays } from "./warTools.ts";
import { runPendingClashes } from "./battleTools.ts";
import { runStorylets } from "./storyletTools.ts";
import { runNaturalRecovery } from "./body.ts";
import { rollWeather } from "../sim/weather.ts";
import { dayOf } from "../rules/time.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 시간이 흐른 뒤 세계 처리. take_action이 시간을 흘린 직후와 세계를 처음 열 때 부른다.
 * - 소문 전파 (하루 단위, 플레이어에게는 보이지 않음)
 * - 세력 전쟁 틱 (하루 단위, 9단계)
 * - 임무 기한 만료, 오늘의 임무 후보
 * 이렇게 하면 다음 장면(GM이 받는 상태)이 항상 처리가 끝난 상태다.
 * 플레이어에게 보여 줄 결과만 돌려준다.
 */
/** 오늘의 날씨를 정한다 (날이 바뀌면 한 번) */
function runDailyWeather(ctx: ToolContext) {
  const s = ctx.content.scenario;
  const state = ctx.store.getState();
  const today = dayOf(state.time);
  if (!s.weather || state.weather?.day === today) return;
  const id = rollWeather(s, today, ctx.rng);
  if (id) ctx.store.append({ type: "weather_set", day: today, weatherId: id });
}

export function runAfterTimeAdvance(ctx: ToolContext): ToolDisplayEvent[] {
  runDailyWeather(ctx);
  spreadRumors(ctx);
  // 세력 단위 전쟁 (하루 단위). 자기 무리가 낀 교전 소식은 화면에 보인다
  const war = runWarDays(ctx);
  // 예정 시각이 된 교전: 그 자리에 있으면 전투 장면이 열린다
  const battles = runPendingClashes(ctx);
  const missions = runMissionStartOfTurn(ctx);
  // 분대원에게 맡긴 일이 끝났으면 결과를 굴리고 보고를 받는다
  const squad = runSquadOrders(ctx);
  // 동행: 떨어져 있던 사람의 합류, 임무 짝의 귀대, 관계가 바닥이면 떠남, 목적을 이루면 갈림길
  const companions = runCompanions(ctx);
  // 조건이 맞는 이야기 (간격이 지났고 전투 중이 아닐 때)
  const storylets = runStorylets(ctx);
  // 새 부상 없이 며칠이 지나면 조금씩 낫는다
  const healed = runNaturalRecovery(ctx);
  return [...war, ...battles, ...missions, ...squad, ...companions, ...storylets, ...healed];
}
