import { disasterWeather } from "./disasters.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { runRestock } from "./gear.ts";
import { runPromotions } from "./people.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { runSquadOrders } from "./command.ts";
import { runCompanions } from "./companionTools.ts";
import { spreadRumors } from "./reputationTools.ts";
import { runWarDays } from "./warTools.ts";
import { runPendingClashes } from "./battleTools.ts";
import { runStorylets } from "./storyletTools.ts";
import { runNaturalRecovery, runWearOff } from "./body.ts";
import { runHelpless } from "./helpless.ts";
import { runBleeding } from "./bleeding.ts";
import { runFearDecay } from "./fear.ts";
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
  // 큰 재난(혹한)이 덮친 동안은 그 날씨 (12-169)
  const id = disasterWeather(ctx.content, state, today) ?? rollWeather(s, today, ctx.rng);
  if (id) ctx.store.append({ type: "weather_set", day: today, weatherId: id });
}

export function runAfterTimeAdvance(ctx: ToolContext): ToolDisplayEvent[] {
  // 의식불명 등 스스로 아무것도 못 하게 됐으면 진행 중이던 이야기는 거기서 끝난다 (깨어난 뒤에 대화가 이어지지 않게)
  {
    const s = ctx.store.getState();
    const me = s.characters[s.playerId];
    if (s.activeStorylet && me && !me.dead && incapacitatingSymptom(ctx.content.scenario, me)) ctx.store.append({ type: "storylet_expired", storyletId: s.activeStorylet.id });
  }
  // 의식불명 중 곁의 사람이 할 일 (12-90): 돌봄·옮김·붙잡힘·죽임·감염체
  // 곁의 사람이 먼저 (쓰러진 그 자리에 있던 사람이 지혈부터 한다), 그다음 피를 흘린 만큼 부상이 커진다. 긁힘은 저절로 멎는다 (12-91)
  const helpless = runHelpless(ctx);
  const bled = runBleeding(ctx);
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
  // 깊이 엮인 이름 없는 인물이 자란다 (기획서 7.10)
  const grown = runPromotions(ctx);
  // 상인은 날마다 물건을 다시 채운다 (기획서 4.8)
  runRestock(ctx);
  // 조건이 맞는 이야기 (간격이 지났고 전투 중이 아닐 때)
  const storylets = runStorylets(ctx);
  // 새 부상 없이 며칠이 지나면 조금씩 낫는다
  const healed = runNaturalRecovery(ctx);
  // 무서운 것이 장면에 없으면 공포가 가라앉는다 (12-95)
  const calmed = runFearDecay(ctx);
  // 술·진통제·각성제 기운이 빠진다 (12-157)
  const worn = runWearOff(ctx);
  return [...helpless, ...bled, ...war, ...battles, ...missions, ...squad, ...companions, ...grown, ...storylets, ...healed, ...calmed, ...worn];
}
