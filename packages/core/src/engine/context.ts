import { staunchHelper } from "../rules/company.ts";
import { heldOf, heldSeenZone, pausedWhileHeld } from "../rules/held.ts";
import { maskUnknownNames } from "./storyletTools.ts";
import { josa } from "../text.ts";
import { describeDisaster } from "./disasters.ts";
import { agendaCue } from "./agenda.ts";
import { describeFacilities } from "./facilities.ts";
import { describeAmbush } from "./ambush.ts";
import { describeResolve } from "./resolve.ts";
import { describeExploration } from "./exploration.ts";
import { askedPromises, promiseLines } from "./promises.ts";
import { describeRequestForGm, requestOfferLines } from "./requests.ts";
import { isQuestTarget } from "../rules/request.ts";
import { originLine } from "./extras.ts";
import { describeMarket } from "./market.ts";
import { describeInfiltration } from "./infiltration.ts";
import { leverageLines } from "./leverage.ts";
import { standingInFaction } from "../game/politics.ts";
import { tiesOf } from "../game/ties.ts";
import { fireHere } from "./forage.ts";
import { describeRemains } from "./remains.ts";
import { incapacitatingSymptom } from "../scenario/scenario.ts";
import { fameOf, stanceOf } from "../game/fame.ts";
import { describeDiplomacyForGm } from "./diplomacy.ts";
import { heardRumors } from "./factionTalk.ts";
import { describeFatigue } from "./fatigue.ts";
import { describeCamp } from "./camp.ts";
import { describeStash } from "./stash.ts";
import { infestationSign } from "../game/infestation.ts";
import { KIND_LABELS, templateKind } from "../game/kinds.ts";
import { describePersona } from "./persona.ts";
import { knowsPlayerSecretLine, settingLines } from "../rules/self.ts";
import { describeTemperature, feelsLike, frostOmen } from "./climate.ts";
import { troubleLine } from "./factionTalk.ts";
import { rankName } from "../game/ranks.ts";
import { attracted, romanceAllowed } from "./romance.ts";
import { knowsDeath, knowsReputation, playerCalls, withKnownNames } from "../game/acquaintance.ts";
import { describeRomanceForGm } from "./romance.ts";
import { describeCaptivityForGm } from "./captivity.ts";
import { describeHistoryPart, type HistoryPart } from "../game/background.ts";
import { occupationOf, occupationTitle } from "../game/occupation.ts";
import { dayOf, formatAgo } from "../rules/time.ts";
import { describeGear } from "./gear.ts";
import { describeProfileLines, describeTieLines } from "./people.ts";
import { describePolicyForGm, describeSquadForGm } from "./command.ts";
import { describeAccess, describeCultureForGm } from "../game/culture.ts";
import { describeCompanions } from "../game/companions.ts";
import { commanderOf } from "../game/missions.ts";
import { weatherNow } from "../sim/weather.ts";
import { describeExtraTemplates } from "./extras.ts";
import { aliasOf, hasMet, headingAs, knowsName } from "../game/acquaintance.ts";
import { isIncapacitated, waterHere } from "./body.ts";
import { attractionOf, looksOf, oppositeSex, sameSex, traitLabels } from "./traits.ts";
import { DIFFICULTY_MODIFIER } from "../rules/check.ts";
import {
  conditionPenalty,
  describeConditions,
  initialConditions,
  speechLevel,
} from "../scenario/scenario.ts";
import { formatTime } from "../rules/time.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Character, Inventory } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import type { Content, NpcContent } from "../content/schemas.ts";
import { describeMissionsForGm } from "./missionTools.ts";
import { describeFactionsForGm } from "./warTools.ts";
import { describeBattleForGm } from "./battleTools.ts";
import { describeStoryletForGm } from "./storyletTools.ts";
import { describeImprovSlotForGm } from "./improvStory.ts";
import { BELIEF_SOURCE_LABELS as SOURCE_LABELS } from "../game/belief.ts";
import { NEUTRAL_RELATION, RELATION_AXES, RELATION_AXIS_LABELS, relationLabel } from "../game/reputation.ts";
import { ownedBy } from "../rules/home.ts";
import { pastGiven, shownSkill, unlearnedNote } from "../rules/skill.ts";
import { personFactLines, personFacts } from "./personFacts.ts";
import { tracesHere } from "./felt.ts";
import { maskUnknownIds } from "../rules/knowledge.ts";
import { currentPlace, depthAt, doorLabel, homeHidden, knowsPlace, peopleAt, placesIn, sharesPlace, unknownDoors } from "../rules/place.ts";
import { inZone, nearby, whereIs } from "../rules/place.ts";
import { beliefText, deedText, matureCard, MENACE_COVER, shownOccupationTitle, toneDownLine } from "../rules/lens.ts";

/**
 * 정보 필터 (기획서 6.2).
 * GM 프롬프트에는 현재 캐릭터의 Belief State와 그 캐릭터가 볼 수 있는 것만 넣는다 (CLAUDE.md 원칙 4).
 * - 플레이어의 믿음은 출처와 함께 넣고, 진짜 정확도(accuracy)는 넣지 않는다
 * - 장면에 있는 NPC는 연기에 필요한 프로필을 넣되, 비밀(secret)과 모르는 것(doesnt_know)은 넣지 않는다
 * - 장면에 없는 인물은 플레이어가 아는 공개 정보만 넣는다
 * - 숨은 목격자는 행적 시점에 드러나지 않는다. 그 인물이 장면에 들어오면 "이 인물이 아는 당신의 행적"으로만 반영된다
 * - 비밀은 신뢰가 공개 조건을 넘었을 때 "털어놓을 수 있다"는 사실만 알리고, 내용은 reveal_secret 결과로만 나온다
 */

/** 프롬프트에 넣을 최근 Belief 수 */
export const MAX_BELIEFS_IN_PROMPT = 30;
/** 장면 정보에 늘 넣는 최근 믿음 수 (나머지는 장면 인물에 관한 것만) */
export const RECENT_BELIEFS_IN_PROMPT = 10;

/** 평판의 첫 문장 (한 줄 요약용) */
function shortNote(text: string): string {
  const first = text.split(/(?<=[.다])\s/)[0] ?? text;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

const VALUE_LABELS: Record<string, string> = {
  discipline: "규율",
  loyalty: "의리",
  mercy: "자비",
  honesty: "정직",
  self_interest: "실리",
};

function weatherLine(state: GameState, content: Content): string {
  const w = weatherNow(content.scenario, state);
  // 내일 한파·눈이면 오늘 낌새가 보인다 (E2)
  const f = state.forecast?.day === dayOf(state.time) + 1 ? content.scenario.weather?.kinds.find((k) => k.id === state.forecast!.id) : undefined;
  // 날씨 낌새가 없어도 내일 새벽이 처음 영하면 낌새 (12-239)
  const frost = f?.omen ? null : frostOmen(content, state);
  return (w ? ` · 날씨: ${w.label} (${w.description})` : "") + (f?.omen ? ` · 낌새: ${f.omen}` : frost ? ` · 낌새: ${frost}` : "");
}

const genderOf = (s: { creation?: { genders: { id: string; label: string }[] } }, id: string | null) => {
  const label = s.creation?.genders.find((g) => g.id === id)?.label;
  return label ? ` · ${label}` : "";
};

export function describePlayerState(state: GameState, content: Content): string {
  return describePlayerSections(state, content)
    .map((s) => s.text)
    .join("\n\n");
}

/** 장면 정보의 이름 붙은 덩어리 (바뀐 것만 다시 보낼 때 쓴다, 기획서 11.6 토큰) */
export type SceneSection = { key: string; text: string };

export function describePlayerSections(state: GameState, content: Content): SceneSection[] {
  const player = state.characters[state.playerId];
  if (!player) throw new Error("플레이어 캐릭터가 없습니다.");

  const scenario = content.scenario;
  const stats = scenario.stats.map((s) => `${s.label}(${s.id}) ${signed(player.stats[s.id] ?? 0)}`).join(", ");
  const difficulty = Object.entries(DIFFICULTY_MODIFIER)
    .map(([k, v]) => `${k} ${signed(v)}`)
    .join(", ");

  const sections: [string, string][] = [
    ["status", [
      `시각: ${formatTime(state.time)}${weatherLine(state, content)}`,
      ...(describeTemperature(content, state) ? [`기온: ${describeTemperature(content, state)}${coldHint(content, state)}`] : []),
      `상태: ${describeConditions(scenario, player)} (판정 보정 ${signed(conditionPenalty(scenario, player))})`,
      ...(describeFatigue(content, state) ? [describeFatigue(content, state)!] : []),
      ...(describeCamp(content, state) ? [describeCamp(content, state)!] : []),
      ...describeInfiltration(content, state),
      ...describeExploration(content, state),
      ...(describeMarket(content, state) ? [describeMarket(content, state)!] : []),
      ...(incapacitatingSymptom(scenario, player)
        ? [
            `${incapacitatingSymptom(scenario, player)!.label}: 주인공은 스스로 아무것도 하지 못한다. 말하지도 움직이지도 판정하지도 않는다. 흐릿한 감각(소리, 냄새, 몸의 고통)의 조각만 짧게 서술하고, take_action의 activity(wait 또는 sleep, 전투 중이면 null)로 시간이 흐르게 한다. 이야기는 열리지 않는다. 곁의 사람(우리 편·적)이 주인공에게 무엇을 하는지는 코드가 정하고 take_action 결과로 알린다: 옮기거나 붙잡거나 해치는 일을 서술로 지어내지 않는다. 장면의 치료사가 돌보면 treatment {item: null}`,
          ]
        : []),
      ...bleedingLine(content, player, state),
      `소지품: ${describeInventory(content, player.inventory)}`,
      ...depositLines(state, content),
      ...(describeStash(content, state) ? [describeStash(content, state)!] : []),
      ...(describeGear(content, player) ? [describeGear(content, player, state)] : []),
      ...(Object.keys(player.debts ?? {}).length ? [`빚 (장부에 적힌 양): ${Object.entries(player.debts).map(([f, n]) => `${content.factions[f]?.name ?? f} ${n}`).join(", ")}. 갚는 일감이나, 그 무리 사람에게 갚는다고 건넨 물건(transfer_item repay)으로만 준다`] : []),
      `장면에 놓인 물건: ${describeInventory(content, state.scene.items)}`,
      ...describeRemains(state, content),
      ...(describeCompanions(state, content) ? [describeCompanions(state, content)] : []),
      ...(player.skillPoints > 0 ? [`스킬 포인트 ${player.skillPoints}점 (올리기: -1→0 1점, 0→+1 2점, +1→+2 3점). 적당한 때 플레이어에게 무엇을 올릴지(모아 둘지) 묻고 learn_skill로 올린다`] : []),
    ].join("\n")],
    ["sheet", [
      // 명성·무리 안의 눈·현상금은 자주 바뀌지 않아 시트에 둔다 (플레이 테스트 11: 상태 덩어리에 있어 매 턴 되풀이됐다)
      ...standingLines(state, content),
      ...(content.scenario.fame && fameOf(state, content).tier > 0
        ? [`명성: ${fameOf(state, content).label}. 소문을 들은 사람이 처음 보고도 당신을 알아볼 수 있다 (인물 카드의 팬·안티 줄). 플레이어에게 숫자는 말하지 않는다`]
        : []),
      ...((state.bounties ?? []).length
        ? [`현상금: ${josa(state.bounties.map((f) => content.factions[f]?.name ?? f).join(", "), "이/가")} 당신 머리에 값을 걸었다 (소문으로 안다). 그 무리의 땅과 말이 모이는 곳에서는 알아보는 눈이 있다. 값은 시스템이 정한다 (지어내지 않는다)`]
        : []),
      `캐릭터: ${player.name} (id: ${player.id}) · ${content.roles[state.roleId]?.rank === player.rank ? content.roles[state.roleId]!.label : rankName(content, player.factionId, player.rank)}${genderOf(scenario, player.gender)}${player.age ? ` · ${player.age}세` : ""}`,
      ...(occupationOf(content, player)
        ? [`직분: ${occupationTitle(content, player)} (${occupationOf(content, player)!.summary}). 이 일로 평판을 쌓으면 직분 안에서 오른다 (이야기·일감의 결과로만)`]
        : []),
      ...(player.past ? [`과거 배경: ${player.past.label} — ${player.past.summary}${pastGiven(content, player.past.id) ? ` (${pastGiven(content, player.past.id)})` : ""} (붕괴 전에 하던 일. 몸에 밴 솜씨와 버릇, 아는 사람과 기억에 묻어난다)`] : []),
      ...(player.motive ? [`동기: ${player.motive.label} — ${player.motive.summary} (이 사람을 움직이는 것. 장면과 선택, 독백에 묻어나게. 대신 행동을 정하지는 않는다)`] : []),
      ...(state.background.length && state.playerId === "player"
        ? [`지난 일 (세계의 사실, 주인공이 아는 대로): ${state.background.map((e) => describeHistoryPart(content, nameNowKnown(state, e.part))).join(" / ")}`]
        : []),
      describeContentRating(state, content),
      describeDialogueStyle(state),
      `트레잇 (서술에 반영한다): ${traitLabels(content, player, { acting: true }).join(", ") || "없음"}`,
      ...(scenario.persona
        ? [
            `성격: ${describePersona(content, player, { acting: true }) || "보통 (말투·태도는 플레이어 뜻대로)"}. ` +
              "말투·태도·말의 양은 이 성격대로 연기한다 (1은 가끔, 2는 자주). 플레이어가 말하지 않은 행동·말을 성격 때문에 넣었으면 문장 끝에 (다혈질)처럼 꼬리표를 붙인다 (한 턴에 한두 번까지). 결과가 남는 일(공격, 거래, 약속, 비밀 털어놓기)은 성격으로 끼워 넣지 않는다. 도발당하면 take_action.provoked",
          ]
        : []),
      ...settingLines(content, state, player, { player: true, name: (id) => headingAs(state, content, player.id, id) }),
      `능력: ${stats}`,
      `스킬 (이름(id·쓸 수 있는 능력), 판정 보정 = 능력 + 스킬, 최대 ${signed(scenario.ranges.cap)}. ${unlearnedNote(scenario)}): ${scenario.moves.map((m) => `${m.label}(${m.id}·${m.stats.map((st) => scenario.stats.find((x) => x.id === st)?.label ?? st).join("/")}) ${shownSkill(content, player, m.id) === null ? "못 함" : signed(shownSkill(content, player, m.id)!)}`).join(", ")}`,
      `난이도 보정: ${difficulty}`,
    ].join("\n")],
    ["battle", [describeCaptivityForGm(state, content), describeBattleForGm(state, content), ...describeAmbush(content, state)].filter(Boolean).join("\n")],
    ["romance", describeRomanceForGm(state, content)],
    // 다짐·시설·재난은 자주 바뀌지 않아 따로 둔다 (시각이 바뀔 때마다 다시 싣지 않게)
    ["resolve", describeResolve(state, content).join("\n")],
    ["disaster", describeDisaster(content, state).join("\n")],
    ["storylet", [describeStoryletForGm(state, content), describeImprovSlotForGm(state, content)].filter(Boolean).join("\n")],
    ["missions", [describeMissionsForGm(state, { content }), describePolicyForGm(state, content), describeRequestForGm(state, content)].filter(Boolean).join("\n")],
    ["squad", describeSquadForGm(state, content)],
    ["diplomacy", describeDiplomacyForGm(state, content)],
    ["culture", player.factionId ? [describeAccess(content, state.roleId), describeCultureForGm(content, player.factionId)].filter(Boolean).join("\n") : ""],
    ["factions", describeFactionsForGm(state, content)],
    ["deeds", describeOwnDeeds(state)],
    ["present", describePresentNpcs(state, content, player)],
    ["known", describeKnownPeople(state, content)],
    ["facilities", describeFacilities(content, state).join("\n")],
    ["zone_people", [describePlaces(state, content), tracesHere(state, content), describeFort(state, content), describeInfestation(state, content), describeWater(state, content), describeTrap(state, content), describeZonePeople(state, content)].filter(Boolean).join("\n")],
    ["zone_extras", describeZoneExtras(state, content)],
    ["templates", describeExtraTemplates(state, content)],
    ["beliefs", describeBeliefs(state, content)],
  ];
  // 이름 모르는 사람의 id는 겉 id로 (공통 규칙 7, PT21)
  return sections.filter(([, text]) => !!text).map(([key, text]) => ({ key, text: maskUnknownIds(text, state, content) }));
}

/** 이번 턴의 user 메시지. 상태와 입력을 구분해 넣는다 */
/** 끌림·질투 (기획서 4.6 "외모와 끌림"): GM이 태도로 연기한다 */
function attractionNotes(content: Content, npc: Character, player: Character): string[] {
  if (!attractionOf(content, npc)) return [];
  if (oppositeSex(npc, player)) return ["끌림: 이 인물은 이성인 당신에게 끌린다 (호감이 빨리 오르고, 당신의 설득·거짓말에 약하다). 말이 많아지거나 허세를 부린다"];
  if (sameSex(npc, player) && looksOf(content, player) > 0) return ["질투: 이 인물은 같은 성별인 당신의 외모를 질투한다. 비꼬거나 경쟁하려 든다"];
  return [];
}

function describePresentNpcs(state: GameState, content: Content, player: Character): string {
  if (state.scene.present.length === 0) return "함께 있는 인물: 없음 (이름 있는 인물이 등장하면 npc_presence로 알린다)";
  const cards = state.scene.present.map((id) => {
    const npc = content.npcs[id];
    const character = state.characters[id];
    if (npc && character) return describeNpcCard(state, content, npc, character, player);
    if (character?.extra) return describeExtraCard(state, content, character, player);
    return `- ${id}`;
  });
  // 성적 위협 (12-59): 수위가 켜져 있고, 둘 다 성인이고, 그 인물이 주인공에게 끌릴 때만 GM에게 알린다
  // 위협은 늘 굴린 세계 상태다. 꺼져 있으면 일반 위협(괴롭힘·강탈)으로 보인다 (공통 규칙 21)
  const menace = state.scene.present
    .filter((id) => state.characters[id]?.menace && romanceAllowed(state, content, id, player.id) && attracted(state, content, id, player.id))
    .map((id) =>
      state.options?.mature
        ? `[GM 전용, 성인 주제] ${playerCalls(state, content, id)}: ${MENACE_LABELS[state.characters[id]!.menace!]}. 판정과 이야기로만 다룬다 (위협·시도까지, 행위는 그리지 않는다)`
        : `[GM 전용] ${playerCalls(state, content, id)}: ${MENACE_COVER}. 판정과 이야기로만 다룬다`,
    );
  return [`함께 있는 인물:\n${cards.join("\n\n")}`, ...menace].join("\n");
}

/**
 * 남의 짐 줄의 머리: 동행·이름을 아는 사람은 그냥, 낯선 사람은 [GM 전용] (플레이 테스트 12: 처음 본 약장수의 짐이 다 보였다).
 * 꺼내 보이거나 흥정·뒤지기로 드러날 때까지 주인공은 모른다
 */
function carriedLabel(state: GameState, player: Character, id: string): string {
  return state.companions.includes(id) || knowsName(state, player.id, id) ? "지닌 것" : "[GM 전용] 지닌 것 (주인공은 모른다. 꺼내 보이거나 흥정·뒤지기로 드러날 때까지 말하지 않는다)";
}

/** 엑스트라의 연기용 카드: 호칭, 겉모습, 상태, 지닌 것, 트레잇, 이름을 아는지 */
function describeExtraCard(state: GameState, content: Content, c: Character, player: Character): string {
  const ex = c.extra!;
  const relation = state.relations[c.id]?.[player.id] ?? NEUTRAL_RELATION;
  const attitude = RELATION_AXES.map((axis) => `${RELATION_AXIS_LABELS[axis]} ${relationLabel(relation[axis])}`).join(", ");
  const template = content.extras[ex.template];
  // 동물·감염체는 사람의 사정(계급·곤경·이름)을 쓰지 않는다 (12-111)
  const animal = templateKind(template) !== "person";
  return [
    animal
      ? `### ${headingAs(state, content, player.id, c.id)} (${c.id})`
      : `### ${headingAs(state, content, player.id, c.id)} (${c.id}) · ${kinTitle(state, content, c.id)}${shownOccupationTitle(state, content, c) ? ` · ${shownOccupationTitle(state, content, c)}` : ""}${genderOf(content.scenario, c.gender)}${c.age ? ` · ${c.age}세` : ""}`,
    `겉모습: ${ex.look}`,
    `상태: ${describeConditions(content.scenario, c)} / ${carriedLabel(state, player, c.id)}: ${describeInventory(content, c.inventory)}${isIncapacitated(content, c) ? " / 무력화됨 (판정 없이 뒤질 수 있다)" : ""}`,
    template?.kind === "infected"
      ? `[GM 전용] 감염체 (틀: ${template.label}). 말이 통하지 않고 산 사람을 보면 덤빈다. 맞서는 판정의 opponent·target으로 둔다 (다칠 위험에 감염이 저절로 붙는다)`
      : `[GM 전용: 연기에만 쓴다] ${animal ? KIND_LABELS[templateKind(template)] : c.profile ? "자란 인물" : "이름 없는 인물"} (틀: ${template?.label ?? ex.template}). 당신에 대한 태도: ${attitude}`,
    ...describeProfileLines(state, content, c),
    ...describeTieLines(state, content, c.id),
    `트레잇: ${traitLabels(content, c, { acting: true }).join(", ") || "-"}`,
    ...(!animal && describePersona(content, c) ? [`성격: ${describePersona(content, c)} (말투·태도에 반영한다. 1은 가끔, 2는 자주)`] : []),
    ...(animal ? [] : settingLines(content, state, c)),
    ...[knowsPlayerSecretLine(content, state, c.id)].filter((x): x is string => !!x),
    ...(animal ? [] : [originLine(content, c)].filter((x): x is string => !!x)),
    ...(animal ? [] : [troubleLine(state, content, c)].filter((x): x is string => !!x)),
    ...attractionNotes(content, c, player),
    ...(animal ? [] : nameNotes(state, player.id, c.id)),
    ...(animal ? [] : rumorLines(state, content, c.id)),
    ...(animal ? [] : [...promiseLines(state, content, c.id), ...requestOfferLines(state, content, c.id)]),
    ...(isQuestTarget(state, c.id) ? ["[GM 전용] 주인공이 받은 의뢰의 목표다"] : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** 쉬어도 추운 자리에서만 붙이는 안내 (12-186: 매 장면 되풀이하지 않는다) */
function coldHint(content: Content, state: GameState): string {
  const comfort = content.scenario.body?.cold?.climate?.comfort;
  const f = feelsLike(content, state, "rest");
  if (comfort === undefined || !f || f.value >= comfort) return "";
  return ". 여기서는 쉬어도 춥다. 추위는 시스템이 기온으로 정한다 (불 피우기는 take_action.use_item에 땔감·판자·기름)";
}

/** 팬·안티 (12-127): 주인공을 직접 보지 않고 소문으로만 아는 사람의 마음 */
function stanceLines(state: GameState, content: Content, id: string): string[] {
  const stance = stanceOf(state, content, id);
  if (stance === "fan") return ["이 인물은 당신을 직접 본 적 없이 소문으로만 알고 동경한다 (팬). 마주치면 알아보고 반기거나 들뜬다"];
  if (stance === "anti") return ["이 인물은 당신을 직접 본 적 없이 소문으로만 알고 경멸한다 (안티). 마주치면 알아보고 차갑게 굴거나 시비를 건다"];
  return [];
}

/** 이 인물이 아는 다른 무리 형편 (12-124): 말이 모이는 곳에 머무는 사람은 오가는 말로 안다 */
function rumorLines(state: GameState, content: Content, id: string): string[] {
  const heard = heardRumors(state, content, id);
  if (heard.length === 0) return [];
  return [`이 인물이 오가는 말로 아는 다른 무리 형편 (말이 모이는 곳에 있다. 물으면 들은 말로 전한다):\n${heard.map((h) => `  - ${h}`).join("\n")}`];
}

/**
 * 말투·예시 대사가 부르는 계급(분대장님 등)이 주인공의 자리와 다르면 알린다 (플레이 테스트 12: 분대장이 아닌 주인공에게 "새 분대장" 말투가 그대로 나왔다)
 */
function rankTitleNote(content: Content, npc: NpcContent, player: Character): string[] {
  const text = [npc.voice.style, ...npc.voice.samples].join(" ");
  const mine = rankName(content, player.factionId, player.rank);
  const titled = [...new Set(content.scenario.rank_ladder.map((r) => r.label).filter((l) => l !== mine && text.includes(`${l}님`)))];
  return titled.length ? [`  (예시 대사의 "${titled.map((t) => `${t}님`).join("·")}"은 그 자리의 사람에게 하는 말이다. 주인공은 ${mine}이라 그렇게 부르지 않는다)`] : [];
}

/** 장면에 있는 NPC의 연기용 카드. secret, doesnt_know는 절대 넣지 않는다 */
function describeNpcCard(
  state: GameState,
  content: Content,
  npc: NpcContent,
  character: Character,
  player: Character,
): string {
  const toPlayer = speechLevel(content.scenario, character, player);
  const fromPlayer = speechLevel(content.scenario, player, character);
  const values = Object.entries(npc.values)
    .map(([k, v]) => `${VALUE_LABELS[k] ?? k} ${signed(v)}`)
    .join(", ");
  // 콘텐츠 문장의 이름 중 주인공이 모르는 것은 호칭으로 (원칙 4, 플레이 테스트 11: 카드의 "모준기의 빚", "마경수의 천막")
  const m = (text: string) => maskUnknownNames(state, content, text);
  // 지키는 것(keeps)은 따로: 물어도 쉽게 말하지 않는다 (플레이 테스트 12)
  const kept = new Set(npc.keeps);
  const knows = (state.beliefs[npc.id] ?? []).filter((b) => !kept.has(b.fact)).map((b) => `  - ${m(beliefText(state, b))}`);
  const keeps = (state.beliefs[npc.id] ?? []).filter((b) => kept.has(b.fact)).map((b) => `  - ${m(beliefText(state, b))}`);
  const relation = state.relations[npc.id]?.[player.id] ?? NEUTRAL_RELATION;
  const attitude = RELATION_AXES.map(
    (axis) => `${RELATION_AXIS_LABELS[axis]} ${signed(relation[axis])}(${relationLabel(relation[axis])})`,
  ).join(", ");
  const knownDeeds = Object.entries(state.deedKnowledge[npc.id] ?? {})
    .map(([deedId, source]) => {
      const deed = state.deeds[deedId];
      return deed?.actorId === player.id ? `  - ${deedText(state, deed)} (${SOURCE_LABELS[source]})` : null;
    })
    .filter((line) => line !== null)
    .slice(-5);
  // 이 인물이 들은 남의 일 (12-151): 장면에 함께 있는 사람이나 이 인물과 이어진 사람의 일만. 거짓인지는 이 인물도 모른다
  const near = new Set([...state.scene.present, ...tiesOf(state, content, npc.id).map((t) => t.other)]);
  const othersDeeds = Object.entries(state.deedKnowledge[npc.id] ?? {})
    .map(([deedId, source]) => {
      const deed = state.deeds[deedId];
      if (!deed || deed.actorId === player.id || deed.actorId === npc.id || !near.has(deed.actorId)) return null;
      return `  - ${headingAs(state, content, player.id, deed.actorId)}: ${deedText(state, deed)} (${SOURCE_LABELS[source]})`;
    })
    .filter((line) => line !== null)
    .slice(-3);
  const secretLine = (() => {
    if (!npc.secret) return null;
    if (state.revealedSecrets.includes(npc.id)) return `당신에게 털어놓은 비밀: ${npc.secret.content}`;
    if (relation.trust >= npc.secret.min_trust) {
      return `이 인물은 이제 당신에게 비밀을 털어놓을 수 있는 관계다. 공개 상황: ${m(npc.secret.reveal_when)}. 상황이 맞으면 reveal_secret`;
    }
    return null;
  })();

  return [
    `### ${headingAs(state, content, player.id, npc.id)} (${npc.id}) · ${rankName(content, character.factionId, character.rank)}${shownOccupationTitle(state, content, character) ? ` · ${shownOccupationTitle(state, content, character)}` : ""}${genderOf(content.scenario, character.gender ?? npc.gender ?? null)} · ${npc.age}세`,
    `외모: ${npc.look}${matureCard(state, content, npc.id)?.look ? ` ${matureCard(state, content, npc.id)!.look}` : ""}`,
    `상태: ${describeConditions(content.scenario, character)} / ${carriedLabel(state, player, character.id)}: ${describeInventory(content, character.inventory)}`,
    `화법: 이 인물의 말투 — ${npc.voice.style} (말투 설명이 우선. 설명에 없는 경우의 기본: 이 인물은 당신에게 ${toPlayer}, 당신은 이 인물에게 ${fromPlayer})`,
    // 예시 대사도 모르는 이름은 호칭으로 (12-294, PT26 하얀매 [정보 누설]: 이름 모르는 경비의 예시 대사 "석유나요")
    `예시 대사: ${npc.voice.samples.map((s) => `"${m(s)}"`).join(" / ")}`,
    ...rankTitleNote(content, npc, player),
    `[GM 전용: 연기에만 쓰고 서술로 직접 드러내지 않는다]`,
    `당신에 대한 태도: ${attitude}`,
    `원하는 것: ${m(npc.want)} / 두려워하는 것: ${m(npc.fear)}`,
    ...(matureCard(state, content, npc.id)?.note ? [`[성인 주제] ${m(matureCard(state, content, npc.id)!.note!)}`] : []),
    `트레잇: ${traitLabels(content, character, { acting: true }).join(", ") || "-"} / 가치관: ${values || "-"}`,
    ...(describePersona(content, character) ? [`성격: ${describePersona(content, character)} (말투·태도에 반영한다. 1은 가끔, 2는 자주)`] : []),
    ...settingLines(content, state, character),
    ...[knowsPlayerSecretLine(content, state, npc.id)].filter((x): x is string => !!x),
    ...[troubleLine(state, content, character)].filter((x): x is string => !!x),
    ...attractionNotes(content, character, player),
    ...nameNotes(state, player.id, npc.id),
    `행동 규칙:\n${npc.rules.map((r) => `  - ${m(r)}`).join("\n") || "  - 없음"}`,
    `이 인물이 아는 것 (물으면 말해 줄 수 있다):\n${knows.join("\n") || "  - 특별히 없음"}`,
    ...(keeps.length ? [`이 인물이 알지만 지키는 것 (먼저 말하지 않고, 물어도 둘러댄다. 행동 규칙을 어길 만큼 몰리거나 깊이 믿을 때만 입을 연다. 판정·이야기 없이 털어놓지 않는다):\n${keeps.join("\n")}`] : []),
    ...rumorLines(state, content, npc.id),
    ...(knownDeeds.length > 0
      ? [`이 인물이 아는 당신의 행적 (당신은 이 인물이 안다는 걸 모를 수 있다. 바로 밝히지 말고 태도에 반영):\n${knownDeeds.join("\n")}`]
      : []),
    ...leverageLines(state, content, npc.id),
    ...[agendaCue(content, state, npc.id)].filter((x): x is string => !!x),
    ...promiseLines(state, content, npc.id),
    ...requestOfferLines(state, content, npc.id),
    // 가르칠 수 있는 것 (사람 정보, 12-241). 파는 물건은 위의 지닌 것, 부탁은 바로 위 줄
    ...personFactLines({ ...personFacts(state, content, npc.id, true), sells: [], asks: [] }),
    ...(othersDeeds.length > 0 ? [`이 인물이 들은 남의 일 (이 인물은 사실로 믿는다. 그 사람을 대하는 태도에 반영):\n${othersDeeds.join("\n")}`] : []),
    ...(secretLine ? [secretLine] : []),
    ...stanceLines(state, content, npc.id),
    ...describeTieLines(state, content, npc.id),
  ].join("\n");
}

/** 이미 기록된 플레이어의 최근 행적 (같은 행동을 다시 기록하지 않게). 숨은 목격자는 넣지 않는다 */
function describeOwnDeeds(state: GameState): string {
  const deeds = Object.values(state.deeds)
    .filter((d) => d.actorId === state.playerId)
    .slice(-5);
  // 당신이 지어낸 소문 (12-151): 듣는 사람은 사실로 믿는다. 당신은 거짓인 줄 안다
  const made = Object.values(state.deeds)
    .filter((d) => d.fabricatedBy === state.playerId)
    .slice(-3)
    .map((d) => `- ${state.characters[d.actorId]?.name ?? d.actorId}에 대해: ${d.summary}`);
  const parts = [
    ...(deeds.length ? [`이미 기록된 당신의 행적 (take_action의 deed로 다시 넣지 않는다):\n${deeds.map((d) => `- ${d.id}: ${deedText(state, d)}`).join("\n")}`] : []),
    ...(made.length ? [`당신이 퍼뜨린 거짓 소문 (듣는 사람은 사실로 믿고 퍼뜨린다):\n${made.join("\n")}`] : []),
  ];
  return parts.join("\n");
}

/**
 * 이름을 아는지에 따른 연기 메모 (기획서 6.3). 이름을 모르면 GM이 그 이름을 쓰지 않게,
 * 상대가 당신 이름을 모르면 이름으로 부르지 않게 한다
 */
function nameNotes(state: GameState, viewer: string, id: string): string[] {
  const notes: string[] = [];
  if (!knowsName(state, viewer, id)) {
    notes.push("당신은 이 인물의 이름을 모른다 (호칭으로 부른다). 상대가 이름을 밝히거나 누가 그 이름을 부르면 learn_name(who: player). 이름을 지어내지 않는다");
  }
  notes.push(
    knowsName(state, id, viewer)
      ? "이 인물은 당신의 이름을 안다"
      : "이 인물은 당신의 이름을 모른다 (이름으로 부르지 않는다). 당신이 이름을 밝히거나 불리면 learn_name(who: target)",
  );
  return notes;
}

/** 엑스트라의 최근 목록에 넣는 수 (오래 안 본 인물은 데이터에 남아도 상태에는 넣지 않는다, *임시*) */
const RECENT_EXTRAS_IN_PROMPT = 5;

function statusNote(content: Content, character: Character, state?: GameState): string {
  // 붙잡혀 있다는 것은 그 자리에 있어야 안다 (원칙 4). 아니면 행방을 모를 뿐이다 (구출 이야기가 그 자리에서 열린다)
  // 같은 구역이라도 감옥 안은 담 밖에서 보이지 않는다: 같이 갇혔거나, 우리 땅이거나, 장면에서 마주쳤을 때만 (플레이 테스트 13: 물류창고에 들어서자 실종자가 "여기 붙잡혀 있다")
  if (heldOf(character) && !character.dead) {
    const me = state?.characters[state.playerId];
    const sees = !!state && state.playerZone === heldOf(character)!.zone && (!!heldOf(me) || state.scene.present.includes(character.id) || (!!me?.factionId && ownedBy(state, state.playerZone, me.factionId)));
    if (sees) return " · 여기 붙잡혀 있다";
    // 갇힌 것을 그 자리에서 본 적 있으면 그 기억대로 (12-259)
    const seen = state ? heldSeenZone(state, character.id) : null;
    return seen ? ` · ${content.locations[seen]?.name ?? seen}에 붙잡혀 있는 것을 봤다` : " · 행방 모름";
  }
  if (character.dead) return !state || knowsDeath(state, content, character.id) ? " · 사망" : "";
  // 장면에 없는 사람의 지금 몸 상태(허기 등)는 주인공이 모른다 (플레이 테스트 8). 장면에 들어오면 카드에 붙는다
  return character.away ? " · 떠남" : "";
}


/**
 * 장면에 없지만 플레이어가 아는 인물. 공개 정보만.
 * 이름을 아는 인물은 이름·평판까지, 얼굴만 아는 콘텐츠 인물은 호칭과 겉모습만 (평판은 그 인물을 아는 사람이 아는 모습이다).
 * 이름 모르는 엑스트라는 구역 목록(describeZoneExtras)에 나온다
 */
function describeKnownPeople(state: GameState, content: Content): string {
  const viewer = state.playerId;
  const absent = (id: string) => !state.scene.present.includes(id) && id !== viewer && state.characters[id];
  const named = (state.known[viewer] ?? []).filter(absent);
  const faces = (state.met[viewer] ?? []).filter((id) => absent(id) && !knowsName(state, viewer, id) && content.npcs[id]);
  const blocks: string[] = [];
  if (named.length > 0) {
    // 이 구역 사람, 진행 중인 이야기의 배역, 상관은 겉모습·평판까지. 나머지는 한 줄 (토큰, 기획서 11.6). 장면에 들어오면 카드 전체가 붙는다
    const commander = commanderOf(state, content);
    const cast = new Set(Object.values(state.activeStorylet?.cast ?? {}));
    // 갇힌 사람은 그곳에 있다고 알 때만 이 구역 사람으로 친다 (PT20 분대장: 갇힌 정찰조장의 줄이 그 구역에 들어설 때만 길어져 위치가 새어 나갔다)
    const near = (id: string) => id === commander || cast.has(id) || (inZone(state, content, id) && (!heldOf(state.characters[id]) || state.scene.present.includes(id) || heldSeenZone(state, id) === state.playerZone));
    // 겉모습·평판까지 싣는 사람은 몇 명만 (12-61, 토큰): 상관·이야기 배역·배경의 사람·연인은 늘, 이 구역의 나머지는 관계가 깊은 순으로 KNOWN_DETAILED까지
    const always = new Set<string>([...(commander ? [commander] : []), ...cast, ...state.background.flatMap((e) => [e.characterId, e.part.kind === "enemy" ? e.part.target : e.part.kind === "loss" ? e.part.by : null].filter((x): x is string => !!x))]);
    for (const r of Object.values(state.romances ?? {})) if (r.stage === "lovers" && (r.a === viewer || r.b === viewer)) always.add(r.a === viewer ? r.b : r.a);
    const depth = (id: string) => {
      const r = state.relations[id]?.[viewer];
      return r ? Math.abs(r.trust) + Math.abs(r.affection) + Math.abs(r.respect) : 0;
    };
    const detailed = new Set([...always].filter((id) => named.includes(id)));
    for (const id of named.filter((id) => near(id) && !detailed.has(id)).sort((x, y) => depth(y) - depth(x) || x.localeCompare(y))) {
      if (detailed.size >= KNOWN_DETAILED) break;
      detailed.add(id);
    }
    const head = (id: string) => {
      const character = state.characters[id]!;
      const npc = content.npcs[id];
      const gender = genderOf(content.scenario, character.gender ?? npc?.gender ?? null);
      return `- ${headingAs(state, content, viewer, id)} (${id}) · ${state.family?.includes(id) ? kinTitle(state, content, id) : rankName(content, character.factionId, character.rank)}${gender}${statusNote(content, character, state)}`;
    };
    const lines: string[] = [];
    const rest: string[] = [];
    for (const id of named) {
      const character = state.characters[id]!;
      const npc = content.npcs[id];
      // 행방을 모르는 사람(붙잡혀 있다)의 지금 모습은 모른다 (플레이 테스트 11: "손목에 끈 자국")
      // 같은 구역에 들어서도 장면에서 보기 전에는 모른다 (12-267, PT19 분대장: 물류창고에 막 들어서자 수용소에 있는 둘의 끈 자국·판자가 실렸다)
      const unseen = !!heldOf(character) && !state.scene.present.includes(id);
      // 평판은 아는 사이에만 (원칙 4, 사용자 결정: 플레이어 화면 ?인물과 같은 기준, 플레이 테스트 14)
      const rep = npc && knowsReputation(state, content, id) ? npc.reputation : "";
      if (detailed.has(id)) lines.push(`${head(id)}: ${npc ? (unseen ? rep : `${npc.look} ${rep}`.trim()) : unseen ? "" : (character.extra?.look ?? "")}`.replace(/: $/, ""));
      // 관계가 생겼거나 상태가 있는 사람은 한 줄, 아무 일 없는 사람은 이름만 모은다
      else if (depth(id) > 0 || heldOf(character) || (character.dead && knowsDeath(state, content, id)) || character.away || !npc) lines.push(`${head(id)}${rep ? `: ${shortNote(rep)}` : ""}`);
      else rest.push(`${headingAs(state, content, viewer, id)}(${id})`);
    }
    blocks.push(
      `알고 있는 인물 (지금 장면에는 없다. 자세한 것은 장면에 들어오면 붙는다):\n${lines.join("\n")}` +
        (rest.length ? `\n- 그 밖에 아는 사람 (아직 별일 없는 사이): ${rest.join(", ")}` : ""),
    );
  }
  if (faces.length > 0) {
    const lines = faces.map((id) => `- ${headingAs(state, content, viewer, id)} (${id})${statusNote(content, state.characters[id]!, state)}${(heldOf(state.characters[id]!) && !state.scene.present.includes(id)) ? "" : `: ${content.npcs[id]!.look}`}`);
    blocks.push(`얼굴만 아는 인물 (이름은 모른다. 지금 장면에는 없다):\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/**
 * 지금 구역에 있을 만한 인물 (등장시킬 수 있는 사람). 만난 적 없는 인물은 이름 없이 겉모습만 준다.
 * 만나도 이름은 모른다 (learn_name). 비밀·평판 같은 프로필은 장면에 들어온 뒤에만 넣는다
 */
/** 이 구역의 낯선 사람을 장면에 싣는 수 (토큰, 12-42) */
/** 알고 있는 인물 중 겉모습·평판까지 싣는 사람 수 (상관·배역·배경·연인 말고, 12-61) */
export const KNOWN_DETAILED = 6;
export const ZONE_PEOPLE_IN_PROMPT = 5;

/** 날마다 순서가 바뀌는 수 (같은 날이면 같다) */
function rotate(id: string, day: number): number {
  let h = day * 2654435761;
  for (const ch of id) h = ((h ^ ch.charCodeAt(0)) * 16777619) >>> 0;
  return h;
}

/** 사람 카드의 직함: 무리와 계급 (설계 목록 10-7, PT17·18 튜토리얼: 가족 카드가 "주민"·"버들마을 주민"으로 달랐다).
 * 가족 관계는 이름 뒤 호칭(headingAs)에 이미 있다: 두 번 쓰지 않는다 (PT22 튜토리얼) */
function kinTitle(state: GameState, content: Content, id: string): string {
  const c = state.characters[id]!;
  // 찾는 가족은 다시 만나기 전에는 무리를 모른다 (12-292, PT22~24 튜토리얼: 찾기 전부터 "버들마을 주민"이 보였다)
  // (가족은 처음부터 아는 사이라 만남 기록으로는 못 가른다: 다시 만나 장면에 들었다 나간 적이 있는지로 본다)
  const found = state.scene.present.includes(id) || state.companions.includes(id) || (c.extra?.lastSeenAt ?? 0) > state.runStartedAt;
  if (state.family?.includes(id) && !found) return "행방 모름";
  return `${c.factionId ? (content.factions[c.factionId]?.name ?? c.factionId) + " " : ""}${rankName(content, c.factionId, c.rank)}`;
}

/** 이 구역의 장소 (공통 규칙 15): 지금 있는 곳과 옮겨 갈 수 있는 곳, 그곳에 있을 아는 사람.
 * 주인공이 아는 장소만 싣고, 모르는 이웃은 '알 수 없는 문'으로 (설계 목록 C-1, 원칙 4) */
function describePlaces(state: GameState, content: Content): string {
  const all = placesIn(state, content, state.playerZone);
  if (!all.length) return "";
  const places = all.filter((p) => knowsPlace(state, content, state.playerZone, p.id));
  const here = currentPlace(state, content);
  const known = new Set([...(state.known[state.playerId] ?? []), ...(state.met[state.playerId] ?? [])]);
  // 담 있는 구역이면 장소마다 담 밖·담 문·담 안 (설계 목록 1-6, PT20 튜토리얼: 초소가 담 밖인지 몰랐다)
  const walled = all.some((p) => p.gate);
  const depthNames = content.scenario.infiltration?.depths ?? [];
  const wallOf = (p: (typeof all)[number]) => (walled && depthNames.length ? ` [${depthNames[depthAt(state, content, p.id) ?? 0] ?? ""}]` : "");
  const line = (p: (typeof places)[number]) => {
    // 갇힌 사람은 그 자리에 있는 것을 주인공이 알 때만 (12-262, PT16·PT17 졸병: 적 거점에 막 들어서자 행방 모를 실종자의 자리가 보였다)
    // 집이 있는 아는 사람(가족 등)은 이 판에서 직접 본 뒤에만 (12-267, PT19·PT20 튜토리얼, 공통 규칙 15 homeHidden)
    const people = peopleAt(state, content, state.playerZone, p.id).filter((id) => known.has(id) && (p.id === here?.id || !homeHidden(state, id)) && (!heldOf(state.characters[id]) || p.id === here?.id || heldSeenZone(state, id) === state.playerZone));
    // 이웃과 길 (장소 개편): 이웃은 5분, 길은 이어지는 구역
    const toZones = p.road && p.to.length ? `, 길: ${p.to.map((z) => content.locations[z]?.name ?? z).join("·")} 쪽` : "";
    // "· 이웃: 이름들"이 "이웃이 그 사람"으로 읽혔다 (PT20·PT21 세 판): 이웃 칸과 사람을 나눠 적는다
    const nearLine = here && here.near.includes(p.id) ? " (이웃 칸)" : "";
    return `- ${p.id} ${p.name}${wallOf(p)} (${p.indoor ? "실내" : "바깥"}${p.spawned ? ", 즉흥" : ""}${toZones})${p.description ? ` ${p.description}` : ""}${p.id === here?.id ? " ← 지금 여기" : nearLine}${people.length ? ` — 있을 사람: ${people.map((id) => playerCalls(state, content, id)).join(", ")}` : ""}`;
  };
  const doors = unknownDoors(state, content);
  const hidden = all.length - places.length - doors.length;
  return [
    `지금 있는 곳: ${here ? `${here.name} (${here.indoor ? "실내" : "바깥"}${here.road ? ", 구역에 드나드는 길" : ""})` : "장소를 모른다"}. 같은 구역 안의 다른 장소로는 take_action place_to (이웃 5분, 한 칸 멀 때마다 5분). 목록에 없는 곳은 spawn_place로 만든다 (지금 자리의 이웃이 된다)`,
    "이 구역의 장소 (주인공이 아는 곳, 그곳에 있을 아는 사람):",
    ...places.map(line),
    ...(doors.length
      ? [
          `지금 자리에서 이어지는 모르는 곳 (place_to에 "문1"처럼. 들어가 봐야 무엇이 있는지 안다. 플레이어에게 보이는 대로 묘사하고 이름·쓰임을 지어내지 않는다):`,
          ...doors.map((p, i) => `- ${doorLabel(p, i)}`),
        ]
      : []),
    ...(hidden > 0 ? ["(이 구역에는 주인공이 아직 모르는 곳이 더 있다. 모르는 곳을 spawn_place로 만들어 대신하지 않는다: 문을 지나 찾아간다)"] : []),
  ].join("\n");
}

export function describeZonePeople(state: GameState, content: Content): string {
  const zone = state.playerZone;
  if (!zone) return "";
  const people = Object.values(content.npcs).filter(
    // 장소를 정했으면 그 장소에 있을 사람(과 장소가 정해지지 않은 사람)만 (공통 규칙 15)
    (npc) => (heldOf(state.characters[npc.id]) ? whereIs(state, content, npc.id)?.zone === zone : nearby(state, content, npc.id)) && npc.id !== state.playerId && !state.scene.present.includes(npc.id) && !state.characters[npc.id]?.dead && !state.characters[npc.id]?.away,
  );
  // 부탁을 품은 아는 사람이 이 구역에 있으면 GM에게 알린다 (12-195: 다시 만나지 못해 부탁이 조용히 접혔다)
  const askers = [...new Set(askedPromises(state).map((p) => p.to))].filter((id) => people.some((n) => n.id === id));
  const askLine = askers.length
    ? `부탁할 것이 있는 사람이 이 구역에 있다: ${askers.map((id) => `${playerCalls(state, content, id)} (${id})`).join(", ")}. 장면에 들이면(npc_presence) 그 사람이 부탁을 꺼낸다`
    : "";
  // 남의 감옥 안의 낯선 포로는 담 밖에서 보이지 않는다 (플레이 테스트 12: 막 도착했는데 갇힌 사람 목록이 보였다). 같이 갇혔거나 우리 땅이면 보인다
  const me = state.characters[state.playerId];
  const seesCells = !!heldOf(me) || (!!me?.factionId && ownedBy(state, zone, me.factionId));
  // 갇혀 있으면 마주칠 사람은 같이 갇힌 사람과 치료사뿐이다 (플레이 테스트 13: 감방에서 거점 사람 열일곱과 장사꾼이 보였다)
  const strangers = people.filter((npc) => !hasMet(state, state.playerId, npc.id) && (seesCells || !heldOf(state.characters[npc.id])) && (!pausedWhileHeld(state, "strangers") || !!heldOf(state.characters[npc.id]) || !!npc.healer));
  if (strangers.length === 0) return askLine;
  // 갇힌 사람은 이 구역에 와 있으니 갇혀 있다는 것까지 보인다 (돌아다니지 않는다). 사람이 많으면 몇 명만 (토큰, 12-42):
  // 갇힌 사람·떠도는 사람(오늘만 여기 있다) 먼저, 나머지는 날마다 돌아가며
  const captive = (id: string) => !!heldOf(state.characters[id]);
  const day = dayOf(state.time);
  // 장사꾼·치료사는 늘 보이게 먼저 (플레이 테스트 11: 다섯 명씩 도는 목록에 숨어 찾지 못했다)
  const useful = (n: (typeof strangers)[number]) => Number(!!n.merchant || !!n.healer);
  const ordered = [...strangers].sort((a, b) => useful(b) - useful(a) || Number(captive(b.id)) - Number(captive(a.id)) || Number(!!b.roams) - Number(!!a.roams) || rotate(a.id, day) - rotate(b.id, day));
  const shown = ordered.slice(0, ZONE_PEOPLE_IN_PROMPT);
  const lines = shown.map((npc) => `- (${npc.id}) ${npc.alias}${npc.merchant ? " · 물건을 판다 (barter)" : ""}${npc.healer ? " · 다친 사람을 치료한다 (treatment)" : ""}${captive(npc.id) ? " · 이곳에 갇혀 있다 (창살 안, 돌아다니지 않는다)" : ""}: ${shortNote(npc.look)}`);
  const more = strangers.length - shown.length;
  return [askLine, `이 구역에서 마주칠 수 있는 낯선 사람 (등장시키려면 npc_presence. 만나도 이름은 모른다${more > 0 ? `. 이 밖에 ${more}명이 더 있다` : ""}):\n${lines.join("\n")}`].filter(Boolean).join("\n");
}

/** 이 구역에서 전에 엮인, 이름을 모르는 엑스트라 (다시 마주칠 수 있다. npc_presence로 다시 등장시킨다). 최근 몇 명만 */
function describeZoneExtras(state: GameState, content: Content): string {
  const zone = state.playerZone;
  if (!zone) return "";
  const list = Object.values(state.characters)
    // 만난 적 있는 사람만 (12-292, PT24: 아무도 모르게 둔 의뢰 목표가 받자마자 "전에 엮인 인물"에 떴다). 갇힌 사람은 갇힌 곳에서 따로 보인다
    .filter((c) => c.extra && c.extra.zone === zone && !state.scene.present.includes(c.id) && !knowsName(state, state.playerId, c.id) && hasMet(state, state.playerId, c.id) && !heldOf(c))
    .sort((a, b) => b.extra!.lastSeenAt - a.extra!.lastSeenAt)
    .slice(0, RECENT_EXTRAS_IN_PROMPT);
  if (list.length === 0) return "";
  const lines = list.map((c) => `- (${c.id}) ${aliasOf(state, content, c.id)}${c.dead ? " · 죽음" : ""}: ${c.extra!.look}`);
  return `이 구역에서 전에 엮인 이름 모르는 인물 (최근 ${RECENT_EXTRAS_IN_PROMPT}명까지. 다시 등장시키려면 npc_presence):\n${lines.join("\n")}`;
}

/** 플레이어의 Belief. 출처는 넣고 진짜 정확도는 넣지 않는다 */
function describeBeliefs(state: GameState, content: Content): string {
  const all = state.beliefs[state.playerId] ?? [];
  if (all.length === 0) return "";
  // 최근 것과, 지금 장면에 있는 인물에 관한 것만 (나머지는 recall로 찾는다, 기획서 11.6 토큰)
  const names = state.scene.present
    .flatMap((id) => [state.characters[id]?.name, state.characters[id] ? playerCalls(state, content, id) : undefined])
    .filter((n): n is string => !!n && n.length >= 2);
  // "…와 마주쳤다. 이름은 모른다. 겉모습: …"은 인물 목록이 이미 알려 준다. 최근 자리를 차지하지 않고, 그 사람이 장면에 있을 때만 싣는다 (플레이 테스트 4)
  const meeting = (fact: string) => /마주쳤다\.( 이름은 모른다\.)?( 겉모습: .*)?$/.test(fact);
  const recent = new Set(all.filter((b) => !meeting(b.fact)).slice(-RECENT_BELIEFS_IN_PROMPT).map((b) => b.id));
  const about = all.filter((b) => !recent.has(b.id) && names.some((n) => b.fact.includes(n))).slice(-MAX_BELIEFS_IN_PROMPT + RECENT_BELIEFS_IN_PROMPT);
  const shown = all.filter((b) => recent.has(b.id) || about.includes(b));
  // 알게 된 때를 붙인다 (12-178): 사흘 전에 본 병력은 지금과 다를 수 있다
  const lines = shown.map((b) => `- [${BELIEF_SOURCE_LABELS[b.source]} · ${formatAgo(state.time, b.learnedAt)}] ${withKnownNames(state, content, beliefText(state, b))}`);
  const rest = all.length - shown.length;
  // 실을 것이 없으면 머리줄 없이 한 줄로 (플레이 테스트 12: 항목 없는 머리줄이 남았다)
  if (lines.length === 0) return `(당신이 알고 있다고 믿는 것 ${rest}개는 지금 장면과 멀다. 필요하면 recall로 찾는다)`;
  return `당신이 알고 있다고 믿는 것 (틀렸거나 오래된 정보일 수 있다. 며칠 묵은 병력·형편·행방은 지금과 다를 수 있으니 인물이 단정하지 않게 한다):\n${lines.join("\n")}${rest > 0 ? `\n(이 밖에 더 오래된 것 ${rest}개. 필요하면 recall로 찾는다)` : ""}`;
}

function describeInventory(content: Content, inventory: Inventory): string {
  const entries = Object.entries(inventory);
  if (entries.length === 0) return "없음";
  return entries.map(([id, qty]) => `${content.items[id]?.name ?? id}(${id}) ×${qty}`).join(", ");
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * 물 (12-97): 목이 마르거나 빈 물병이 있을 때만 GM에게 알린다. 마시고 채우는 것은 플레이어가 직접 (take_action.drink, refill).
 * 거점의 보급이 넉넉한지는 알리지 않는다 (해 보면 시스템이 정한다)
 */
function describeWater(state: GameState, content: Content): string {
  const source = waterHere(content, state);
  const rules = content.scenario.body?.thirst;
  const me = state.characters[state.playerId];
  if (!source || !rules || !me) return "";
  const empties = Object.keys(rules.refill).filter((i) => (me.inventory[i] ?? 0) > 0).map((i) => content.items[i]?.name ?? i);
  const track = content.scenario.condition_tracks.find((t) => t.id === rules.track);
  const thirsty = (track?.levels.findIndex((l) => l.id === me.conditions[rules.track]) ?? 0) > 0;
  if (!empties.length && !thirsty) return "";
  if (source.kind === "supply") {
    return `물: 우리 거점이다. 서술에서 "물 보급을 받아야 할 것 같다"고 한 번 언급한다${empties.length ? ` (${empties.join("·")}이 비어 있다)` : ""}. 플레이어가 보급을 받겠다고 하면 take_action.refill (마시기까지 한다. 마시기만 하면 drink). 창고 사정에 따라 보급 담당이 조금만 주거나 거절할 수 있다 (시스템이 정한다)`;
  }
  const dirty = rules.dirty ? (fireHere(state) ? " 불이 피어 있어 끓여 마실 수 있다." : " 끓이지 않은 물이다 (불을 피우면 끓여 마신다. 그냥 마시면 탈이 날 수 있다는 것을 서술에 비춘다)") : "";
  return `물: ${source.where ? `${source.where}에서 물을 뜰 수 있다.` : "이곳에는 물이 충분하다."}${dirty}${empties.length ? ` 서술에서 "빈 물병을 가지고 있으니 물을 채우면 될 것 같다"고 한 번 언급한다.` : " 물이 흐르는 모습을 장면에 묘사한다."} 플레이어가 마시겠다고 하면 take_action.drink, 채우겠다고 하면 refill. 저절로 마시거나 채우지 않는다`;
}

/** 이 구역에 놓아 둔 덫 (12-131). 걸렸는지는 거둬 봐야 안다 */
function describeTrap(state: GameState, content: Content): string {
  if (!content.scenario.foraging?.trap || !state.traps.some((t) => t.zone === state.playerZone)) return "";
  return "덫: 이 구역에 놓아 둔 덫이 있다. 걸렸는지는 거둬 봐야 안다 (take_action.trap check)";
}

/** 우리 땅의 보강 (12-48). 주인공은 자기 무리 담만 안다 */
function describeFort(state: GameState, content: Content): string {
  const zone = state.playerZone;
  const me = state.characters[state.playerId];
  const fort = zone ? (state.zones[zone]?.fort ?? 0) : 0;
  if (!zone || !me?.factionId || !ownedBy(state, zone, me.factionId) || fort <= 0) return "";
  return `${content.locations[zone]?.name ?? zone}의 담: ${["", "메워 둠", "단단히 보강함", "망루와 이중 담"][fort]} (습격을 받으면 지키는 쪽이 더 버틴다)`;
}

/** 감염체 낌새 (12-112): 이 구역에서 보이고 들리는 흔적만. 압력 숫자는 넣지 않는다 */
function describeInfestation(state: GameState, content: Content): string {
  const sign = state.playerZone ? infestationSign(content, state, state.playerZone) : null;
  return sign ? `감염체 낌새: ${sign}. 장면에 흔적으로 묘사한다 (마주치면 엑스트라 틀의 감염체를 spawn_extra로 들인다)` : "";
}

/** 수위 (12-57): GM이 지킬 선. 연애는 수위와 상관없이 나오고, 꺼져 있으면 성적인 것(잠자리, 성적 농담·괴롭힘·위협)을 들이지 않는다 */
function describeContentRating(state: GameState, content: Content): string {
  const age = content.scenario.content_rating?.adult_age ?? 18;
  if (!state.options?.mature) {
    return (
      `수위: 성인 주제 꺼짐. 성인 사이의 끌림과 연애는 나온다 (${age}세 미만은 어떤 경우에도 연애 대상이 아니다). 연인 사이도 손잡기·기대기·입맞춤까지, 잠자리는 없다. ` +
      "성적인 농담·괴롭힘·위협을 장면에 들이지 않는다 (플레이어가 원하면 set_content_options로 켤 수 있다고만 알린다). 폭력과 죽음은 담담하게 다룬다"
    );
  }
  return (
    `수위: 성인 주제 켜짐. ${age}세 미만은 주인공이든 인물이든 어떤 경우에도 연애·성적인 대상이 아니다 (나이를 확인한다). ` +
    "성인 사이의 끌림과 연애는 서술하되 잠자리는 암전으로 넘긴다. 성적인 농담·괴롭힘·위협은 이 세계의 위험으로 다룰 수 있다. " +
    "성폭력은 시도와 위협까지만, 행위를 그리지 않고 판정으로 벗어나거나 대가를 치르는 것으로 다룬다 (어떤 판정 결과로도 일어나지 않는다). 노골적인 신체·행위 묘사는 하지 않는다"
  );
}

/** 대화 형식 (12-63): 플레이어가 상태 화면의 설정이나 대화로 고른다 */
function describeDialogueStyle(state: GameState): string {
  if (state.options?.dialogue === "script") {
    return (
      '대화 형식: 대본. 인물의 대사는 서술 문장에 섞지 않고 따로 떼어 한 줄씩 쓴다: **이름**: "대사" (주인공은 **당신**, 이름을 모르는 인물은 호칭). ' +
      "대사 앞뒤의 몸짓·표정은 대사 줄 밖의 서술 문단으로 둔다. 줄마다 빈 줄을 띄운다"
    );
  }
  return "대화 형식: 소설. 인물의 대사는 따옴표로 서술 문장 안에 녹인다 (누가 말하는지는 앞뒤 서술로 드러낸다). \"이름: 대사\" 줄로 떼지 않는다";
}

const MENACE_LABELS = {
  harass: "성적인 농담과 괴롭힘을 일삼는 자",
  coerce: "몸을 거래 조건으로 요구하는 자",
  assault: "힘으로 덮치려 드는 자 (위협·시도)",
} as const;

/** 피를 흘리는 중이면 GM에게 지혈하는 길을 알린다 (12-91) */
function bleedingLine(content: Content, player: Character, state: GameState): string[] {
  const w = content.scenario.wounds;
  if (!w || player.dead) return [];
  const track = content.scenario.condition_tracks.find((t) => t.id === w.track);
  const at = track ? track.levels.findIndex((l) => l.id === player.conditions[w.track]) : -1;
  if (!track || at <= 0) return [];
  const level = track.levels[at]!;
  const every = w.worsen_hours[level.id];
  return [
    `피를 흘리고 있다 (${track.label}): ${every ? `멎지 않으면 ${every}시간마다 부상이 한 단계 나빠지고, 정신이 들거나 저절로 낫지 않는다` : "곧 저절로 멎는다"}. ` +
      `지혈은 붕대·구급상자(treatment.item + check move ${w.staunch_move}), 장면의 치료사(treatment {item: null}), 맨손(treatment {item: null} + check move ${w.staunch_move}, 옷을 찢어 누르기 등). ${w.staunch_move} 판정은 못 함이어도 굴린다 (공통 규칙 12)`,
    // 곁의 사람이 언제 묶어 주는지 (12-256, 공통 규칙 8)
    ...(() => {
      const h = player.id === state.playerId ? staunchHelper(state, content, player.id) : null;
      if (!h) return [];
      const name = playerCalls(state, content, h.id);
      return [h.blocked ? `곁의 ${josa(name, "은/는")} 위협이 가시면 지혈한다.` : `곁의 ${josa(name, "이/가")} 이번 행동이 끝날 때 지혈한다.`];
    })(),
  ];
}

/** 무리 안의 눈 (12-152): 같은 무리에서 주인공을 믿지 않는 사람이 여럿이거나, 믿고 따르는 사람이 많을 때. 숫자는 주지 않는다 */
function standingLines(state: GameState, content: Content): string[] {
  const player = state.characters[state.playerId];
  if (!player?.factionId) return [];
  const { distrust, trust } = standingInFaction(state, content, player.id);
  const lines: string[] = [];
  if (distrust >= STANDING_NOTE_AT) lines.push("무리 안의 눈: 무리 안에 당신을 믿지 않는 사람이 여럿이다. 수군거림과 등 돌린 태도를 연기에 반영한다 (숫자는 말하지 않는다)");
  if (trust >= STANDING_NOTE_AT * 2) lines.push("무리 안의 눈: 무리 안에 당신을 믿고 따르는 사람이 많다");
  return lines;
}

/** 무리 안의 눈 줄을 띄우는 사람 수 */
const STANDING_NOTE_AT = 3;

/** 얼굴만 알던 사람의 이름을 그 뒤에 알게 됐으면, 지난 일도 이름으로 (비극의 고리의 원수) */
function nameNowKnown(state: GameState, part: HistoryPart): HistoryPart {
  if ((part.kind !== "loss" && part.kind !== "enemy") || part.name_known !== false) return part;
  const who = part.kind === "loss" ? part.by : part.target;
  return who && (state.known[state.playerId] ?? []).includes(who) ? { ...part, name_known: true } : part;
}

/** 주인공이 맡긴 물건 (12-196): 누구에게, 무엇을, 어떤 조건으로. 돌려받을 때는 transfer_item (맡은 사람 → 주인공) */
function depositLines(state: GameState, content: Content): string[] {
  const mine = (state.entrusted ?? []).filter((d) => d.owner === state.playerId);
  if (!mine.length) return [];
  return [
    `맡긴 물건 (돌려받으면 transfer_item 맡은 사람 → 주인공, 판정 없이): ${mine.map((d) => `${content.items[d.itemId]?.name ?? d.itemId}${d.quantity > 1 ? ` ×${d.quantity}` : ""} → ${playerCalls(state, content, d.holder)} (${d.holder}), "${d.note}"`).join(" / ")}`,
  ];
}
