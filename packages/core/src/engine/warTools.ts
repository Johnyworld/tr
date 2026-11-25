import { knownCrossings, knownOwner } from "../rules/knowledge.ts";
import { heldByOwn, heldOf } from "../rules/held.ts";
import { runDisasters } from "./disasters.ts";
import { runAgendas } from "./agenda.ts";
import { breakFacilities, runFacilitiesDaily } from "./facilities.ts";
import { runPromisesDaily } from "./promises.ts";
import { runDailyFood } from "./forage.ts";
import { lootRemainsDaily } from "./remains.ts";
import { roleOf } from "../game/state.ts";
import { openingPlace, arrivalPlace, movePlayer } from "../rules/place.ts";
import { endExpiredTruces } from "./diplomacy.ts";
import { runResidentBodies } from "./residents.ts";
import { infestationDay } from "../game/infestation.ts";
import { factionTroubles, spreadTroubleRumors } from "./factionTalk.ts";
import { runCaptivity, warCaptures } from "./captivity.ts";
import type { Content } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS, type Belief } from "../game/belief.ts";
import type { Clash, FactionState, GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { daysOfStock, frontierTarget, HOSTILE, disposition, initialWarWorld, neighbors, rationLevel, simulateWarDay, type WarWorld } from "../sim/war.ts";
import { advanceParties, partiesConfig } from "../sim/parties.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { playerInvolvement, scheduleTime } from "./battleTools.ts";
import { runDailyBody, runDailyNpcBody, runNpcRecovery } from "./body.ts";
import { seasonAt, seasonLabel, seasonOfDay } from "../sim/season.ts";
import { fill, josa, sentence } from "../text.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import {ownedBy, hostileLand, baseOfNow } from "../rules/home.ts";
import { onOwnLand } from "../rules/home.ts";
import { casualtiesToPeople } from "./felt.ts";
import { protectedFromWorld } from "../rules/company.ts";
import { hearNews } from "../rules/news.ts";

/**
 * 하루 단위 전쟁 틱 (기획서 9.2). 시간이 흐른 뒤 날이 바뀌었으면 지난 날만큼(최대 MAX_CATCH_UP_DAYS일) 돌린다.
 * 플레이어는 결과를 소식으로만 안다:
 * - 자기 무리가 낀 교전은 보고(report)로 듣는다 (화면에도 보인다)
 * - 다른 무리끼리의 일은 확률로 소문(rumor)이 된다
 * - 사상자 수는 대략적인 말로만 전한다. 세력 클락(다른 무리의 계획)은 그 무리 사람만 안다
 */

export const MAX_CATCH_UP_DAYS = 7;
export const WAR_TOPIC = "war";
/** 주인공이 혼자 엿들은 다른 무리의 속사정. 보고하기 전에는 무리의 수군거림에 들어가지 않는다 (플레이 테스트 11) */
export const WAR_INTEL_TOPIC = "war_intel";
/** 다른 무리끼리의 교전이 소문으로 들려올 확률 */
export const RUMOR_CHANCE = 0.4;

/**
 * 무리·땅 주인을 콘텐츠의 시작값으로 채운다 (새 세계, 또는 9단계 이전 세이브). 채웠으면 true.
 * 새 세계를 만들 때 배경·설정의 뒷받침(다른 무리, 우리 거점)이 땅 주인을 보기 전에도 부른다 (PT14: 뒷받침이 모두 빠졌다)
 */
export function initFactions(ctx: ToolContext): boolean {
  const { content, store } = ctx;
  if (!content.scenario.war || Object.keys(content.factions).length === 0) return false;
  if (Object.keys(store.getState().factions).length > 0) return false;
  const { factions, zones, clocks } = initialWarWorld(content);
  store.append({ type: "factions_initialized", day: dayOf(store.getState().time), factions, zones, clocks });
  return true;
}

export function runWarDays(ctx: ToolContext): ToolDisplayEvent[] {
  const { content, store } = ctx;
  if (!content.scenario.war || Object.keys(content.factions).length === 0) return [];
  ensurePlayerZone(ctx);
  const today = dayOf(store.getState().time);
  if (initFactions(ctx)) return [];
  const last = store.getState().lastWarDay ?? today;
  const displays: ToolDisplayEvent[] = [];
  for (let day = Math.max(last + 1, today - MAX_CATCH_UP_DAYS + 1); day <= today; day++) {
    // 기한이 된 휴전을 끝낸다 (12-126). 그날 전쟁 틱 전에
    displays.push(...endExpiredTruces(ctx));
    const state = store.getState();
    // 오늘 새벽 교전 중 플레이어가 그 자리에 있는 것은 계산하지 않고 예정해 둔다 (전투 장면, 기획서 9.5)
    const at = scheduleTime(day, ctx.rng);
    const canDefer = day === today && at > state.time;
    // 움직이는 부대는 닿을 때 계산한다: 이날의 부대를 내고 지금(또는 그날 끝)까지 닿은 몫만 푼다. 나머지는 시간이 흐르며 runPartiesNow가.
    // 지금 닿는 교전에 플레이어가 끼면 그 시각의 예정된 교전으로 (전투 장면)
    const upTo = Math.min(day * MINUTES_PER_DAY - 1, state.time);
    const result = simulateWarDay({ factions: state.factions, zones: state.zones, clocks: state.clocks, parties: state.parties, nextPartyNo: state.nextPartyNo, partiesUpTo: state.partiesUpTo }, content, ctx.rng, {
      defer: (spec, arrival) => (arrival === undefined ? canDefer : day === today) && playerInvolvement(state, content, spec) !== null,
      resolveUpTo: upTo,
      endUpTo: upTo,
      // 부대를 이끄는 사람: 세계가 건드리지 않는 사람(주인공·동행·분대·배역·우두머리·갇힌 사람)은 아니다 (1-3)
      leaderOk: (id) => !protectedFromWorld(state, content, id),
      season: seasonOfDay(content.scenario, day),
      infested: state.infested,
      day,
    });
    const scheduled = result.deferred.map(({ at: arrival, ...spec }, i) => ({ ...spec, id: `battle_${state.nextBattleNo + i}`, at: arrival ?? at }));
    store.append({
      type: "war_day_simulated",
      day,
      factions: result.factions,
      zones: result.zones,
      clocks: Object.fromEntries(Object.entries(result.clocks).map(([id, c]) => [id, { filled: c.filled }])),
      clashes: result.clashes,
      scheduled,
      ...(result.parties ? { parties: result.parties, nextPartyNo: result.nextPartyNo ?? state.nextPartyNo, partiesUpTo: result.partiesUpTo ?? state.partiesUpTo } : {}),
    });
    // 감염체 압력: 전날의 소음, 오늘 새벽 교전의 시체 (12-112). 어제 부대가 닿아 벌어진 교전의 시체도 (닿을 때 계산)
    const yesterday = store.getState().recentClashes.filter((r) => r.party && r.at >= (day - 2) * MINUTES_PER_DAY && r.at < (day - 1) * MINUTES_PER_DAY).map((r) => r.clash);
    for (const change of infestationDay(content, store.getState(), day, [...result.clashes, ...yesterday], ctx.rng)) store.append({ type: "infestation_changed", ...change });
    displays.push(...afterClashes(ctx, result.clashes, { facilities: false }));
    // 다른 무리의 형편이 소문으로 (12-105)
    displays.push(...spreadTroubleRumors(ctx));
    // 무리 사이 싸움의 포로, 시설이 부서짐 (12-55, 12-167)
    displays.push(...afterClashes(ctx, result.clashes, { news: false }));
    // 텃밭이 자란다 (12-167)
    runFacilitiesDaily(ctx, day);
    // 인물의 자기 일 (12-168)
    displays.push(...runAgendas(ctx, day));
    // 큰 재난 (12-169)
    displays.push(...runDisasters(ctx, day));
    runCaptivity(ctx);
    // 연애: 다른 연인을 알아채기, 같은 사람을 보는 두 사람 (12-58)
    // 무리의 태도가 바뀐 소식 (이탈, 편들기): 우리 무리 일이면 전해 듣고, 아니면 소문으로
    // 크게 도는 말이라 남의 일도 늘 소문으로 닿는다 (공통 규칙 14)
    for (const shift of result.shifts) displays.push(...hearNews(ctx, { fact: sentence(shift.news), factions: [shift.factionId, shift.to], always: true, topic: WAR_TOPIC }));
    // 하루가 지난 몸: 배급에 따른 허기, 감염 진행
    displays.push(...runDailyBody(ctx, day));
    // NPC도 낫는다: 저절로, 그리고 무리 의무실의 돌봄 (12-52). 병이 진행되기 전에 돌보므로, 오늘 드러난 열은 하루를 넘긴 뒤에야 의무실이 손쓴다
    displays.push(...runNpcRecovery(ctx));
    displays.push(...runDailyNpcBody(ctx, day));
    // 거점 사람들의 허기·추위 (12-125): 무리의 형편이 사람 몸에 보인다
    displays.push(...runResidentBodies(ctx, day));
    // 묻지 않은 유해는 누군가 조금씩 털어 간다 (12-130)
    lootRemainsDaily(ctx);
    // 덫에 걸리고, 날것이 상한다 (12-131)
    displays.push(...runDailyFood(ctx));
    // 기한을 넘긴 약속은 어긴 것이다 (12-160). 꺼내지 못한 부탁은 접고, 새 부탁을 품는다 (12-174)
    for (const line of runPromisesDaily(ctx)) displays.push({ type: "belief", fact: line, sourceLabel: "약속", note: line });
  }
  return displays;
}

/**
 * 교전 뒤의 일 (하루 틱과 닿을 때 계산이 함께 쓴다): 소식, 사상자 가운데 이름 있는 대원 (12-242), 포로 (12-55), 시설이 부서짐 (12-167, 내 거처·우리 거점이면 소식)
 */
export function afterClashes(ctx: ToolContext, clashes: readonly Clash[], only: { news?: boolean; facilities?: boolean } = {}): ToolDisplayEvent[] {
  const { store } = ctx;
  if (!clashes.length) return [];
  const displays: ToolDisplayEvent[] = [];
  if (only.news !== false) {
    displays.push(...deliverNews(ctx, clashes));
    displays.push(...casualtiesToPeople(ctx, clashes));
  }
  if (only.facilities !== false) {
    displays.push(...warCaptures(ctx, clashes));
    const now = store.getState();
    const mine = new Set([now.homes[now.playerId], ...Object.entries(now.zones).filter(([, z]) => z.owner === now.characters[now.playerId]?.factionId).map(([id]) => id)]);
    for (const b of breakFacilities(ctx, clashes)) if (mine.has(b.zone)) displays.push({ type: "belief", fact: b.line, sourceLabel: "소식" });
  }
  return displays;
}

/**
 * 움직이는 부대를 지금까지 움직인다 (닿을 때 계산, docs/war-parties-plan.md ③): 닿은 부대의 할 일, 부대끼리의 마주침, 돌아온 부대.
 * 하루 틱 사이, 시간이 흐를 때마다 부른다. 플레이어가 낄 교전은 그 시각의 예정된 교전으로 (전투 장면)
 */
export function runPartiesNow(ctx: ToolContext): ToolDisplayEvent[] {
  const { content, store } = ctx;
  const state = store.getState();
  if (!partiesConfig(content) || !state.parties.length || state.partiesUpTo >= state.time) return [];
  const world: WarWorld = { factions: structuredClone(state.factions), zones: structuredClone(state.zones), clocks: structuredClone(state.clocks), parties: structuredClone(state.parties), nextPartyNo: state.nextPartyNo, partiesUpTo: state.partiesUpTo };
  const r = advanceParties(world, content, ctx.rng, state.time, { defer: (spec) => playerInvolvement(state, content, spec) !== null, endUpTo: state.time });
  const scheduled = r.deferred.map(({ at, ...spec }, i) => ({ ...spec, id: `battle_${state.nextBattleNo + i}`, at }));
  store.append({
    type: "parties_advanced",
    factions: world.factions,
    zones: world.zones,
    clocks: Object.fromEntries(Object.entries(world.clocks).map(([id, c]) => [id, { filled: c.filled }])),
    parties: world.parties ?? [],
    partiesUpTo: world.partiesUpTo ?? state.time,
    clashes: r.clashes,
    scheduled,
  });
  return afterClashes(ctx, r.clashes);
}

/** 플레이어가 있는 구역을 정한다: 역할의 시작 장소, 없으면 소속 세력의 거점 (9-1 이전 세이브 포함) */
function ensurePlayerZone(ctx: ToolContext) {
  const state = ctx.store.getState();
  if (state.playerZone || Object.keys(ctx.content.locations).length === 0) return;
  const player = state.characters[state.playerId];
  if (!player) return;
  const start = roleOf(ctx.content, state)?.start_location;
  const zone =
    (start && ctx.content.locations[start] ? start : null) ??
    baseOfNow(state, ctx.content, player.factionId) ??
    null;
  if (!zone) return;
  movePlayer(ctx, { zone, place: arrivalPlace(state, ctx.content, zone) }, "start");
  // 역할의 시작 장소(start_place), 없으면 시작 장면 글이 이 구역의 장소 하나를 말할 때 처음부터 그 장소에 둔다 (12-259, 공통 규칙 15 openingPlace,
  // PT15 분대장: "보급 창고 앞"으로 시작했는데 구역에 막 들어선 자리였다)
  const role = roleOf(ctx.content, ctx.store.getState());
  const spot = role?.start_place && role.start_location === zone ? role.start_place : role?.opening_scene ? openingPlace(ctx.store.getState(), ctx.content, role.opening_scene) : null;
  if (spot) movePlayer(ctx, { zone, place: spot }, "start");
}

/** 교전 소식을 플레이어의 믿음으로 남긴다 (공통 규칙 14) */
function deliverNews(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  return clashes.flatMap((clash) => hearNews(ctx, { fact: describeClash(ctx.content, clash), factions: [clash.attacker, clash.defender], topic: WAR_TOPIC, showOursOnly: true }));
}

/** 사상자 수를 대략적인 말로 (정확한 수는 간부나 알 일이다) */
export function lossWords(n: number): string {
  if (n <= 0) return "없음";
  if (n <= 2) return "한두 명";
  if (n <= 5) return "몇 명";
  return "여럿";
}

export function describeClash(content: Content, clash: Clash): string {
  const news = content.scenario.war!.news;
  const name = (id: string | null) => (id ? (content.factions[id]?.name ?? id) : "");
  const template = clash.kind === "occupy" ? news.occupy : news[`${clash.kind}_${clash.success ? "success" : "failure"}`];
  return sentence(
    fill(template, {
      attacker: name(clash.attacker),
      defender: name(clash.defender),
      zone: content.locations[clash.zone]?.name ?? clash.zone,
      attacker_loss: lossWords(clash.attackerLosses),
      defender_loss: lossWords(clash.defenderLosses),
    }),
  );
}

// ── 정보 필터를 거친 세력 정보 (명령어·GM 컨텍스트·화면) ─────────────

export type FactionOutlook = {
  /** 소속 무리 */
  own: {
    id: string;
    name: string;
    moraleLabel: string;
    rationLabel: string;
    /** 자원별 대략적인 사정 (들리는 말) */
    stock: { label: string; level: string }[];
    /** 우리 무리의 계획 (세력 클락): 대략적인 진척과 목표로 들리는 곳 */
    plans: { label: string; stage: string; imminent: boolean; targetName: string | null }[];
  } | null;
  /** 아는 세력: 공개 평판과 우리 무리와의 관계 */
  others: { id: string; name: string; public: string; stance: string; size: string }[];
};

const label = (levels: readonly { min_days: number; label: string }[], days: number) =>
  levels.find((l) => days >= l.min_days)?.label ?? levels.at(-1)!.label;

/** 배급 수준 (무리의 배급 자원이 며칠 치 남았는지로) */
export function rationLabel(content: Content, faction: FactionState): string {
  return rationLevel(content, faction).label;
}

export function moraleLabel(content: Content, morale: number): string {
  return content.scenario.war!.morale_labels[morale + 3] ?? String(morale);
}

/**
 * 플레이어가 아는 세력 사정. 다른 무리의 진짜 인원·자원·계획은 넣지 않는다.
 * 규모는 누구나 아는 시작 규모(콘텐츠)로만 말한다.
 */
export function factionOutlook(state: GameState, content: Content): FactionOutlook {
  const war = content.scenario.war;
  const player = state.characters[state.playerId];
  if (!war || !player || Object.keys(state.factions).length === 0) return { own: null, others: [] };
  const ownState = state.factions[player.factionId];
  const ownContent = content.factions[player.factionId];
  const own =
    ownState && ownContent
      ? {
          id: ownContent.id,
          name: ownContent.name,
          moraleLabel: moraleLabel(content, ownState.morale),
          rationLabel: rationLabel(content, ownState),
          stock: content.scenario.resources
            .filter((r) => (war.upkeep[r.id] ?? 0) > 0)
            .map((r) => ({ label: r.label, level: label(war.stock_labels, daysOfStock(content, ownState, r.id)) })),
          plans: Object.values(state.clocks)
            .filter((c) => c.factionId === ownContent.id)
            .map((c, _i, _all) => {
              const ratio = c.filled / c.max;
              const plan = ownContent.plans.find((p) => p.label === c.label);
              const shift = plan?.kind === "shift";
              // 태도가 바뀌는 계획(shift)에는 칠 구역이 없다. 이미 일어났으면 그렇다고만
              const target = shift ? null : c.target || frontierTarget(state, content, c.factionId);
              return {
                label: c.label,
                stage: shift && ratio >= 1 ? "이미 정해졌다는 말" : ratio < 0.34 ? "말만 돈다" : ratio < 0.75 ? (shift ? "윗사람들 사이에 오가는 말이 잦다" : "준비가 한창이라는 말") : shift ? "곧 정해질 거라는 말" : "임박했다는 말",
                imminent: !shift && ratio >= 0.75,
                targetName: target ? (content.locations[target]?.name ?? target) : null,
              };
            }),
        }
      : null;
  const others = Object.values(content.factions)
    .filter((f) => f.id !== player.factionId)
    .map((f) => {
      const d = disposition(content, player.factionId, f.id, state);
      const stance = d <= HOSTILE ? "적대" : d >= 2 ? "연합" : "중립";
      return { id: f.id, name: f.name, public: f.public, stance, size: `약 ${Math.round(f.population / 10) * 10}명` };
    });
  return { own, others };
}

/**
 * 플레이어가 있는 구역과 맞닿은 구역 (전선은 눈에 보이므로 주인을 안다).
 * 설치한 준비물은 그 구역에 있는 것만 (플레이어가 직접 설치한 것)
 */
export function zoneOutlook(state: GameState, content: Content) {
  const zoneId = state.playerZone;
  const loc = zoneId ? content.locations[zoneId] : undefined;
  if (!zoneId || !loc) return null;
  // 땅 주인은 주인공이 아는 대로 (공통 규칙 7, rules/knowledge.ts)
  const known = (id: string) => knownOwner(state, content, id);
  const owner = (id: string) => {
    const o = known(id);
    return o ? (content.factions[o]?.name ?? o) : "빈 땅";
  };
  const prepLabel = (id: string) => content.scenario.battle?.preparations.find((p) => p.id === id)?.label ?? id;
  return {
    id: zoneId,
    name: loc.name,
    description: loc.description,
    owner: owner(zoneId),
    adjacent: neighbors(content, zoneId).map((id) => ({ id, name: content.locations[id]?.name ?? id, owner: owner(id) })),
    /** 들어서 아는 건너는 길 (12-251, 공통 규칙 7): 배로 건넌다. 표가 없으면 판정을 걸고 몰래 */
    crossings: knownCrossings(state, content, zoneId).map((id) => ({ id, name: content.locations[id]?.name ?? id, owner: owner(id), label: content.locations[id]!.crossing!.attempt.label })),
    preparations: (state.preparations[zoneId] ?? []).map(prepLabel),
    /** 플레이어 무리에 적대하는 세력의 구역인지 */
    // 적 땅은 공통 규칙 11 하나로 (12-269: 경보는 걸리는데 GM 화면은 적 땅이 아니라고 했다)
    hostile: hostileLand(state, content, zoneId),
  };
}

/** GM 컨텍스트용 한 덩어리 */
export function describeFactionsForGm(state: GameState, content: Content): string {
  const o = factionOutlook(state, content);
  const z = zoneOutlook(state, content);
  // 구역 줄은 무소속에게도 싣는다 (B4, 플레이 테스트 8·9: move_to에 쓸 id를 몰랐다)
  const zoneLines = z
    ? [
        `현재 구역: ${z.name} (${z.id}, ${z.owner}) · 인접 구역(move_to): ${z.adjacent.map((a) => `${a.id} ${a.name}(${a.owner})`).join(", ")}` +
          (z.crossings.length ? ` · 건너는 길(move_to, 표가 없으면 ${z.crossings.map((c) => c.label).join("·")}): ${z.crossings.map((c) => `${c.id} ${c.name}(${c.owner})`).join(", ")}` : "") +
          (z.preparations.length ? ` · 설치해 둔 준비물: ${z.preparations.join(", ")}` : ""),
        ...(z.hostile ? ["  여기는 적대 세력의 땅이다. 들키면 공격받을 수 있다. 위험한 행동은 판정과 몸의 위험을 선언한다."] : []),
      ]
    : [];
  if (!o.own) return [...zoneLines, ...(content.scenario.seasons ? [`계절: ${seasonLabel(seasonAt(content.scenario, state.time))}`] : [])].join("\n");
  // 갇혀 있으면 우리 무리의 사정·수군거림·계획을 모른다 (플레이 테스트 12: 적 감옥에서 우리 공세 결과와 사상자 수가 보였다)
  if (heldOf(state.characters[state.playerId]) && !heldByOwn(state)) {
    return [
      ...zoneLines,
      `무리 사정: 갇혀 있어 ${o.own.name}의 요즘 사정은 모른다 (붙잡히기 전에 들은 것과 감옥에서 들리는 말뿐).`,
      `세력 관계: ${o.others.map((f) => `${f.name} ${f.stance}`).join(", ")}`,
      ...(content.scenario.seasons ? [`계절: ${seasonLabel(seasonAt(content.scenario, state.time))}`] : []),
      "전황은 캐릭터가 들은 보고·소문(믿음)으로만 안다. 교전 결과·사상자·점령을 지어내지 않는다.",
    ].join("\n");
  }
  return [
    ...zoneLines,
    // 무리 사정은 우리 땅에서만 느낀다 (공통 규칙 11, 12-241: 구시가·진료소에서도 결과마다 실렸다)
    ...(onOwnLand(state) ? [`무리 사정 (캐릭터가 거점에서 느끼는 것): ${o.own.name} · 분위기 ${o.own.moraleLabel} · 배급 ${o.own.rationLabel}`] : []),
    // 우리 땅에 있을 때만 수군거림으로 드러낸다 (플레이 테스트 12: 다른 무리 거점에서도 "우리 땅의 장면이면"이 실렸다)
    ...(factionTroubles(state, content).length && !!state.playerZone && ownedBy(state, state.playerZone, state.characters[state.playerId]?.factionId)
      ? [
          `무리 사람들 사이에 도는 말: ${sentence(factionTroubles(state, content).join(" · "))} 배경의 수군거림, 끼니·당번 자리의 불평이나 다독임으로 한두 마디 드러낸다 (매 턴 같은 말을 되풀이하지 않는다). 인물마다의 태도는 인물 카드의 "무리 형편에 대해". 숫자·사상자를 지어내지 않는다.`,
        ]
      : []),
    `세력 관계: ${o.others.map((f) => `${f.name} ${f.stance}`).join(", ")}`,
    ...o.own.plans.map(
      (p) =>
        `우리 무리의 계획: ${p.label} — ${p.stage}${p.targetName ? ` (목표는 ${josa(p.targetName, "이라는/라는")} 말)` : ""}` +
        (p.imminent ? ". 그 구역과 맞닿은 우리 구역에 있으면 새벽에 함께 나설 수 있다" : ""),
    ),
    ...(content.scenario.seasons ? [`계절: ${seasonLabel(seasonAt(content.scenario, state.time))}`] : []),
    "전황은 캐릭터가 들은 보고·소문(믿음)으로만 안다. 교전 결과·사상자·점령을 지어내지 않는다.",
  ].join("\n");
}
