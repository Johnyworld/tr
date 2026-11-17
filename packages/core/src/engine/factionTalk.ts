import type { Content } from "../content/schemas.ts";
import { baseInfestation, infestationOf } from "../game/infestation.ts";
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
export type TroubleKind = { kind: "morale" } | { kind: "ration" } | { kind: "stock"; resource: string } | { kind: "infested" };
export type Trouble = TroubleKind & { level: number; text: string };

/** 단계마다의 이름: morale는 -1(가라앉음)부터 -3(무너지기 직전), ration·stock은 배급·창고 단계의 차례 */
function levelLabels(content: Content, kind: TroubleKind["kind"]): string[] {
  const war = content.scenario.war!;
  if (kind === "morale") return [1, 2, 3].map((n) => moraleLabel(content, -n));
  if (kind === "ration") return war.ration.levels.map((l) => l.label);
  if (kind === "infested") return content.scenario.infestation?.trouble_labels ?? [];
  return war.stock_labels.map((l) => l.label);
}

/** 소문 한 줄: "{무리} 쪽 …" */
function rumorText(content: Content, name: string, t: TroubleKind, level: number): string {
  const label = levelLabels(content, t.kind)[level] ?? "";
  if (t.kind === "morale") return `${name} 쪽 분위기가 영 좋지 않다는 말이 돈다 (${label})`;
  if (t.kind === "ration") return `${name} 쪽은 배급을 줄였다는 말이 돈다 (${label})`;
  if (t.kind === "infested") return `${name} 쪽 ${label}는 말이 돈다`;
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
  // 땅에 감염체가 몰려들었다 (12-120): 기준값보다 가장 많이 높은 곳만큼
  const labels = content.scenario.infestation?.trouble_labels;
  if (labels) {
    const over = Object.values(content.locations)
      .filter((l) => state.zones[l.id]?.owner === factionId)
      .map((l) => ({ name: l.name, by: infestationOf(content, state, l.id) - baseInfestation(content, l.id) }))
      .filter((z) => z.by > 0);
    const worst = Math.max(0, ...over.map((z) => z.by));
    if (worst > 0) {
      const level = Math.min(labels.length - 1, worst - 1);
      out.push({ kind: "infested", level, text: `${labels[level]} (${over.map((z) => z.name).join(", ")})` });
    }
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
    ...(content.scenario.infestation?.trouble_labels ? [{ kind: "infested" as const }] : []),
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

/**
 * 소문을 직접 확인한다 (턴마다): 주인공이 그 무리의 땅에 있고, 그 무리에 대해 들은 소문이 마지막으로 직접 본 뒤로 있으면
 * 지금의 진짜 형편을 본 것(정확도 exact)으로 남긴다. 들은 말과 다르면 GM이 그 차이를 서술한다 (옛 믿음은 지우지 않고 새 믿음이 앞선다)
 */
export function checkRumorsOnSite(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const owner = state.playerZone ? state.zones[state.playerZone]?.owner : null;
  if (!content.scenario.war?.talk?.rumor || !me || me.dead || !owner || owner === me.factionId || !state.factions[owner]) return [];
  const topic = `${TROUBLE_TOPIC}:${owner}`;
  const about = (state.beliefs[me.id] ?? []).filter((b) => b.topic === topic);
  const lastSeen = Math.max(-Infinity, ...about.filter((b) => b.source === "seen").map((b) => b.learnedAt));
  const rumors = about.filter((b) => b.source === "rumor" && b.learnedAt > lastSeen);
  if (!rumors.length) return [];
  const name = content.factions[owner]?.name ?? owner;
  const troubles = troublesOf(state, content, owner);
  const fact = troubles.length
    ? `${name} 땅에 와서 직접 보니: ${troubles.map((t) => t.text).join(" · ")}`
    : `${name} 땅에 와서 직접 보니 들은 소문만큼 어려워 보이지는 않았다`;
  store.append({
    type: "belief_added",
    characterId: me.id,
    belief: { id: `b_${state.nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time, topic },
  });
  return [
    {
      type: "belief",
      fact,
      sourceLabel: BELIEF_SOURCE_LABELS.seen,
      note: `${name}에 대해 들었던 소문(${rumors.map((b) => `"${b.fact}"`).join(", ")})을 직접 보고 확인했다: ${fact}. 들은 것과 다르면 그 차이를 짧게 서술한다 (무엇이 맞고 틀렸는지는 이 줄에 있는 것만).`,
    },
  ];
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
