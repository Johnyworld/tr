import { runRomance } from "./romance.ts";
import { runCaptivity, warCaptures } from "./captivity.ts";
import type { Content } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS, type Belief } from "../game/belief.ts";
import type { Clash, FactionState, GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { daysOfStock, frontierTarget, HOSTILE, disposition, initialWarWorld, neighbors, rationLevel, simulateWarDay } from "../sim/war.ts";
import { playerInvolvement, scheduleTime } from "./battleTools.ts";
import { runDailyBody, runDailyNpcBody, runNpcRecovery } from "./body.ts";
import { seasonAt, seasonLabel, seasonOfDay } from "../sim/season.ts";
import { fill, josa, sentence } from "../text.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 하루 단위 전쟁 틱 (기획서 9.2). 시간이 흐른 뒤 날이 바뀌었으면 지난 날만큼(최대 MAX_CATCH_UP_DAYS일) 돌린다.
 * 플레이어는 결과를 소식으로만 안다:
 * - 자기 무리가 낀 교전은 보고(report)로 듣는다 (화면에도 보인다)
 * - 다른 무리끼리의 일은 확률로 소문(rumor)이 된다
 * - 사상자 수는 대략적인 말로만 전한다. 세력 클락(다른 무리의 계획)은 그 무리 사람만 안다
 */

export const MAX_CATCH_UP_DAYS = 7;
export const WAR_TOPIC = "war";
/** 다른 무리끼리의 교전이 소문으로 들려올 확률 */
export const RUMOR_CHANCE = 0.4;

export function runWarDays(ctx: ToolContext): ToolDisplayEvent[] {
  const { content, store } = ctx;
  if (!content.scenario.war || Object.keys(content.factions).length === 0) return [];
  ensurePlayerZone(ctx);
  const today = dayOf(store.getState().time);
  if (Object.keys(store.getState().factions).length === 0) {
    // 새 세계, 또는 9단계 이전 세이브: 콘텐츠의 시작값으로 채우고 오늘부터 센다
    store.append({ type: "factions_initialized", day: today, ...initialWarWorld(content) });
    return [];
  }
  const last = store.getState().lastWarDay ?? today;
  const displays: ToolDisplayEvent[] = [];
  for (let day = Math.max(last + 1, today - MAX_CATCH_UP_DAYS + 1); day <= today; day++) {
    const state = store.getState();
    // 오늘 새벽 교전 중 플레이어가 그 자리에 있는 것은 계산하지 않고 예정해 둔다 (전투 장면, 기획서 9.5)
    const at = scheduleTime(day, ctx.rng);
    const canDefer = day === today && at > state.time;
    const result = simulateWarDay({ factions: state.factions, zones: state.zones, clocks: state.clocks }, content, ctx.rng, {
      defer: (spec) => canDefer && playerInvolvement(state, content, spec) !== null,
      season: seasonOfDay(content.scenario, day),
    });
    const scheduled = result.deferred.map((spec, i) => ({ ...spec, id: `battle_${state.nextBattleNo + i}`, at }));
    store.append({
      type: "war_day_simulated",
      day,
      factions: result.factions,
      zones: result.zones,
      clocks: Object.fromEntries(Object.entries(result.clocks).map(([id, c]) => [id, { filled: c.filled }])),
      clashes: result.clashes,
      scheduled,
    });
    displays.push(...deliverNews(ctx, result.clashes));
    // 무리 사이 싸움의 포로, 포로를 먹이고 부리기 (12-55)
    displays.push(...warCaptures(ctx, result.clashes));
    runCaptivity(ctx);
    // 연애: 다른 연인을 알아채기, 같은 사람을 보는 두 사람 (12-58)
    displays.push(...runRomance(ctx));
    // 무리의 태도가 바뀐 소식 (이탈, 편들기): 우리 무리 일이면 전해 듣고, 아니면 소문으로
    for (const shift of result.shifts) {
      const now = ctx.store.getState();
      const player = now.characters[now.playerId];
      if (!player || player.dead) break;
      const ours = shift.factionId === player.factionId || shift.to === player.factionId;
      const source: Belief["source"] = ours ? "report" : "rumor";
      ctx.store.append({
        type: "belief_added",
        characterId: now.playerId,
        belief: { id: `b_${now.nextBeliefNo}`, fact: sentence(shift.news), source, accuracy: "approximate", learnedAt: now.time, topic: WAR_TOPIC },
      });
      displays.push({ type: "belief", fact: sentence(shift.news), sourceLabel: BELIEF_SOURCE_LABELS[source] });
    }
    // 하루가 지난 몸: 배급에 따른 허기, 감염 진행
    displays.push(...runDailyBody(ctx));
    // NPC도 낫는다: 저절로, 그리고 무리 의무실의 돌봄 (12-52). 병이 진행되기 전에 돌보므로, 오늘 드러난 열은 하루를 넘긴 뒤에야 의무실이 손쓴다
    displays.push(...runNpcRecovery(ctx));
    displays.push(...runDailyNpcBody(ctx));
  }
  return displays;
}

/** 플레이어가 있는 구역을 정한다: 역할의 시작 장소, 없으면 소속 세력의 거점 (9-1 이전 세이브 포함) */
function ensurePlayerZone(ctx: ToolContext) {
  const state = ctx.store.getState();
  if (state.playerZone || Object.keys(ctx.content.locations).length === 0) return;
  const player = state.characters[state.playerId];
  if (!player) return;
  const start = ctx.content.roles[state.roleId]?.start_location;
  const zone =
    (start && ctx.content.locations[start] ? start : null) ??
    Object.values(ctx.content.locations).find((l) => l.kind === "base" && l.owner === player.factionId)?.id ??
    null;
  if (zone) ctx.store.append({ type: "zone_moved", from: null, to: zone });
}

/** 교전 소식을 플레이어의 믿음으로 남긴다 */
function deliverNews(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  const displays: ToolDisplayEvent[] = [];
  for (const clash of clashes) {
    const state = ctx.store.getState();
    const player = state.characters[state.playerId];
    if (!player || player.dead) return displays;
    const ours = clash.attacker === player.factionId || clash.defender === player.factionId;
    if (!ours && ctx.rng() >= RUMOR_CHANCE) continue;
    const source: Belief["source"] = ours ? "report" : "rumor";
    const fact = describeClash(ctx.content, clash);
    ctx.store.append({
      type: "belief_added",
      characterId: state.playerId,
      belief: { id: `b_${state.nextBeliefNo}`, fact, source, accuracy: "approximate", learnedAt: state.time, topic: WAR_TOPIC },
    });
    if (ours) displays.push({ type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS[source] });
  }
  return displays;
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
  const owner = (id: string) => {
    const o = state.zones[id]?.owner ?? null;
    return o ? (content.factions[o]?.name ?? o) : "빈 땅";
  };
  const prepLabel = (id: string) => content.scenario.battle?.preparations.find((p) => p.id === id)?.label ?? id;
  return {
    id: zoneId,
    name: loc.name,
    description: loc.description,
    owner: owner(zoneId),
    adjacent: neighbors(content, zoneId).map((id) => ({ id, name: content.locations[id]?.name ?? id, owner: owner(id) })),
    preparations: (state.preparations[zoneId] ?? []).map(prepLabel),
    /** 플레이어 무리에 적대하는 세력의 구역인지 */
    hostile: (() => {
      const owner = state.zones[zoneId]?.owner;
      const mine = state.characters[state.playerId]?.factionId;
      return !!owner && !!mine && owner !== mine && disposition(content, mine, owner, state) <= HOSTILE;
    })(),
  };
}

/** GM 컨텍스트용 한 덩어리 */
export function describeFactionsForGm(state: GameState, content: Content): string {
  const o = factionOutlook(state, content);
  if (!o.own) return "";
  const z = zoneOutlook(state, content);
  return [
    ...(z
      ? [
          `현재 구역: ${z.name} (${z.id}, ${z.owner}) · 인접 구역(move_to): ${z.adjacent.map((a) => `${a.id} ${a.name}(${a.owner})`).join(", ")}` +
            (z.preparations.length ? ` · 설치해 둔 준비물: ${z.preparations.join(", ")}` : ""),
          ...(z.hostile ? ["  여기는 적대 세력의 땅이다. 들키면 공격받을 수 있다. 위험한 행동은 판정과 몸의 위험을 선언한다."] : []),
        ]
      : []),
    `무리 사정 (캐릭터가 거점에서 느끼는 것): ${o.own.name} · 분위기 ${o.own.moraleLabel} · 배급 ${o.own.rationLabel}`,
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
