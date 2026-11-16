import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { moraleLabel, WAR_TOPIC } from "./warTools.ts";

/**
 * 무리 형편 (기획서 9.13, 12-105): 거점 사람들이 입에 올리는 우리 무리의 어려움.
 * 주인공이 거점에서 느끼는 것(분위기·배급·창고 사정)과 주인공이 들은 전황(믿음)만 쓴다. 다른 무리의 사정이나 숨은 사실은 넣지 않는다 (원칙 4)
 */

/** 최근 전황 소식으로 치는 시간 */
const NEWS_HOURS = 48;

/**
 * 한 무리의 형편 (분위기·배급·창고). 진짜 상태에서 나오므로 주인공에게는 자기 무리 것이나 소문으로만 보인다.
 * kind와 level(나쁠수록 크다)로 나눠 두어 소문이 부풀거나 지어질 수 있게 한다
 */
export type TroubleKind = { kind: "morale" } | { kind: "ration" } | { kind: "stock"; resource: string };
export type Trouble = TroubleKind & { level: number; text: string };

/** 단계마다의 이름: morale는 -1(가라앉음)부터 -3(무너지기 직전), ration·stock은 배급·창고 단계의 차례 */
function levelLabels(content: Content, kind: TroubleKind["kind"]): string[] {
  const war = content.scenario.war!;
  if (kind === "morale") return [1, 2, 3].map((n) => moraleLabel(content, -n));
  if (kind === "ration") return war.ration.levels.map((l) => l.label);
  return war.stock_labels.map((l) => l.label);
}

/** 소문 한 줄: "{무리} 쪽 …" */
function rumorText(content: Content, name: string, t: TroubleKind, level: number): string {
  const label = levelLabels(content, t.kind)[level] ?? "";
  if (t.kind === "morale") return `${name} 쪽 분위기가 영 좋지 않다는 말이 돈다 (${label})`;
  if (t.kind === "ration") return `${name} 쪽은 배급을 줄였다는 말이 돈다 (${label})`;
  const r = content.scenario.resources.find((x) => x.id === t.resource)?.label ?? t.resource;
  return `${name} 쪽 ${r} 창고는 ${label}이 돈다`;
}

export function troublesOf(state: GameState, content: Content, factionId: string): Trouble[] {
  const war = content.scenario.war;
  const f = state.factions[factionId];
  if (!war || !f) return [];
  const out: Trouble[] = [];
  if (f.morale <= -1) out.push({ kind: "morale", level: -f.morale - 1, text: `분위기가 ${moraleLabel(content, f.morale)}` });
  const ration = rationLevel(content, f);
  const ri = war.ration.levels.indexOf(ration);
  if (ri > 0) out.push({ kind: "ration", level: ri, text: `배급: ${ration.label}` });
  // 창고: "빠듯하다"보다 나쁜 것만 (두 번째 문턱 아래)
  const tight = war.stock_labels[1]?.min_days ?? 7;
  for (const r of content.scenario.resources) {
    if ((war.upkeep[r.id] ?? 0) <= 0) continue;
    const days = daysOfStock(content, f, r.id);
    const si = Math.max(0, war.stock_labels.findIndex((l) => days >= l.min_days));
    const level = war.stock_labels.findIndex((l) => days >= l.min_days) < 0 ? war.stock_labels.length - 1 : si;
    if (days < tight) out.push({ kind: "stock", resource: r.id, level, text: `${r.label}: ${war.stock_labels[level]!.label}` });
  }
  return out;
}

/** 지금 우리 무리 사람들 사이에 도는 어려움 (우리 무리의 형편 + 주인공이 들은 최근 전황). 없으면 빈 목록 */
export function factionTroubles(state: GameState, content: Content): string[] {
  const player = state.characters[state.playerId];
  if (!content.scenario.war || !player || !state.factions[player.factionId]) return [];
  const out = troublesOf(state, content, player.factionId).map((t) => t.text);
  // 주인공이 들은 최근 전황 (믿음이라 주인공이 아는 것뿐)
  const news = (state.beliefs[player.id] ?? []).filter((b) => b.topic === WAR_TOPIC && state.time - b.learnedAt <= NEWS_HOURS * 60).slice(-2);
  for (const b of news) out.push(`전황: ${b.fact}`);
  return out;
}

export const TROUBLE_TOPIC = "faction_trouble";

/**
 * 다른 무리의 형편이 소문으로 들린다 (하루에 한 번, 전쟁 틱과 함께). 말이 모이는 곳(war.talk.rumor.zones)에 있으면 무리마다:
 * - 형편이 어려우면 chance로 그중 하나를 듣는다. 그곳의 exaggerate 확률로 한 단계 부풀려진다
 * - 멀쩡해도 false_chance로 없는 어려움을 듣는다 (헛소문)
 * 정확도(exact·approximate·false)는 시뮬레이션만 안다 (GM 프롬프트에 넣지 않는다). 같은 무리의 같은 말은 사흘 안에 다시 듣지 않는다
 */
export function spreadTroubleRumors(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const rule = content.scenario.war?.talk?.rumor;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const place = state.playerZone ? rule?.zones[state.playerZone] : undefined;
  if (!rule || !place || !me || me.dead) return [];
  const war = content.scenario.war!;
  const kinds: TroubleKind[] = [
    { kind: "morale" },
    { kind: "ration" },
    ...content.scenario.resources.filter((r) => (war.upkeep[r.id] ?? 0) > 0).map((r) => ({ kind: "stock" as const, resource: r.id })),
  ];
  const displays: ToolDisplayEvent[] = [];
  for (const f of Object.values(content.factions)) {
    if (f.id === me.factionId || !state.factions[f.id]) continue;
    const troubles = troublesOf(state, content, f.id);
    let heard: { fact: string; accuracy: "exact" | "approximate" | "false" } | null = null;
    if (troubles.length && rng() < rule.chance) {
      const t = troubles[Math.floor(rng() * troubles.length)]!;
      const top = levelLabels(content, t.kind).length - 1;
      const puffed = rng() < place.exaggerate && t.level < top;
      heard = { fact: rumorText(content, f.name, t, puffed ? t.level + 1 : t.level), accuracy: puffed ? "approximate" : "exact" };
    } else if (rng() < rule.false_chance) {
      // 없는 어려움: 실제로 겪고 있지 않은 종류를 고른다
      const free = kinds.filter((k) => !troubles.some((t) => t.kind === k.kind && (k.kind !== "stock" || (t.kind === "stock" && t.resource === k.resource))));
      if (free.length) {
        const k = free[Math.floor(rng() * free.length)]!;
        const labels = levelLabels(content, k.kind);
        heard = { fact: rumorText(content, f.name, k, k.kind === "morale" ? 1 : Math.max(1, labels.length - 2)), accuracy: "false" };
      }
    }
    if (!heard) continue;
    const now = store.getState();
    const recent = (now.beliefs[me.id] ?? []).some((b) => b.topic === `${TROUBLE_TOPIC}:${f.id}` && b.fact === heard!.fact && now.time - b.learnedAt < 3 * 24 * 60);
    if (recent) continue;
    store.append({
      type: "belief_added",
      characterId: me.id,
      belief: { id: `b_${now.nextBeliefNo}`, fact: heard.fact, source: "rumor", accuracy: heard.accuracy, learnedAt: now.time, topic: `${TROUBLE_TOPIC}:${f.id}` },
    });
    displays.push({ type: "belief", fact: heard.fact, sourceLabel: BELIEF_SOURCE_LABELS.rumor });
  }
  return displays;
}

/** 이 인물이 무리 형편을 대하는 태도: 트레잇이 가장 많이 겹치는 것, 없으면 기본 */
export function troubleAttitude(content: Content, c: Character): { label: string; hint: string } | null {
  const talk = content.scenario.war?.talk;
  if (!talk) return null;
  const traits = new Set(traitsOf(content, c).map((t) => t.id));
  let best: { label: string; hint: string; score: number } | null = null;
  for (const a of talk.attitudes) {
    const score = a.traits.filter((t) => traits.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { label: a.label, hint: a.hint, score };
  }
  return best ?? talk.default;
}

/** 인물 카드의 한 줄: 같은 무리 사람이고 어려움이 있을 때만 */
export function troubleLine(state: GameState, content: Content, c: Character): string | null {
  const player = state.characters[state.playerId];
  if (!player || c.id === player.id || c.dead || !c.factionId || c.factionId !== player.factionId) return null;
  const troubles = factionTroubles(state, content);
  const attitude = troubleAttitude(content, c);
  if (!troubles.length || !attitude) return null;
  return `무리 형편에 대해: ${attitude.label} (${attitude.hint}). 말을 섞으면 이런 말이 나올 수 있다: ${troubles.join(" · ")}`;
}
