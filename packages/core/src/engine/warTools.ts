import type { Content } from "../content/schemas.ts";
import { BELIEF_SOURCE_LABELS, type Belief } from "../game/belief.ts";
import type { Clash, FactionState, GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { daysOfStock, HOSTILE, disposition, initialWarWorld, simulateWarDay } from "../sim/war.ts";
import { fill, sentence } from "../text.ts";
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
    const result = simulateWarDay({ factions: state.factions, zones: state.zones, clocks: state.clocks }, content, ctx.rng);
    store.append({
      type: "war_day_simulated",
      day,
      factions: result.factions,
      zones: result.zones,
      clocks: Object.fromEntries(Object.entries(result.clocks).map(([id, c]) => [id, { filled: c.filled }])),
      clashes: result.clashes,
    });
    displays.push(...deliverNews(ctx, result.clashes));
  }
  return displays;
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
  } | null;
  /** 아는 세력: 공개 평판과 우리 무리와의 관계 */
  others: { id: string; name: string; public: string; stance: string; size: string }[];
};

const label = (levels: readonly { min_days: number; label: string }[], days: number) =>
  levels.find((l) => days >= l.min_days)?.label ?? levels.at(-1)!.label;

/** 배급 수준 (무리의 배급 자원이 며칠 치 남았는지로) */
export function rationLabel(content: Content, faction: FactionState): string {
  const war = content.scenario.war!;
  return label(war.ration.levels, daysOfStock(content, faction, war.ration.resource));
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
        }
      : null;
  const others = Object.values(content.factions)
    .filter((f) => f.id !== player.factionId)
    .map((f) => {
      const d = disposition(content, player.factionId, f.id);
      const stance = d <= HOSTILE ? "적대" : d >= 2 ? "연합" : "중립";
      return { id: f.id, name: f.name, public: f.public, stance, size: `약 ${Math.round(f.population / 10) * 10}명` };
    });
  return { own, others };
}

/** GM 컨텍스트용 한 덩어리 */
export function describeFactionsForGm(state: GameState, content: Content): string {
  const o = factionOutlook(state, content);
  if (!o.own) return "";
  return [
    `무리 사정 (캐릭터가 거점에서 느끼는 것): ${o.own.name} · 분위기 ${o.own.moraleLabel} · 배급 ${o.own.rationLabel}`,
    `세력 관계: ${o.others.map((f) => `${f.name} ${f.stance}`).join(", ")}`,
    "전황은 캐릭터가 들은 보고·소문(믿음)으로만 안다. 교전 결과·사상자·점령을 지어내지 않는다.",
  ].join("\n");
}
