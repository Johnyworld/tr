import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { infestationOf } from "../game/infestation.ts";
import { seasonOfDay } from "../sim/season.ts";
import { fill, josa, sentence } from "../text.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 큰 재난 (기획서 9.18, 12-169). 한 해에 두어 번, 도시 전체가 흔들리는 일. 일어나는 날·곳·크기는 코드가 정한다 (원칙 2).
 * - 예정: 날마다 per_year에 맞춘 확률로 (앞 재난에서 min_gap_days가 지났을 때) 그 계절에 맞는 재난 하나를 warn_days 뒤로 잡는다
 * - 전조: 그사이 GM 상태에 낌새가 보이고 (그 구역·이웃·우리 무리일 때), 전조 이야기(when.disaster phase omen)가 열린다. 대비(disaster_prepare)하면 피해가 준다
 * - 타격: 자원·인원·사기, 담·시설, 산출 멈춤, 감염체 압력, 날씨, 돌림병(그 무리의 이름 있는 사람·주인공이 앓는다), 거점을 잃을 수도 (collapse)
 * - 그 뒤 recover_days 동안 재난 뒤 이야기(phase struck)가 열리고, 끝나면 다음 재난을 기다린다
 */

type Kind = NonNullable<Content["scenario"]["disasters"]>["kinds"][number];
export type Disaster = NonNullable<GameState["disaster"]>;

const rules = (content: Content) => content.scenario.disasters;
const kindOf = (content: Content, id: string) => rules(content)?.kinds.find((k) => k.id === id);

/** 재난이 덮칠 곳: 재난 종류의 target 규칙대로 (null이면 도시 전체) */
function pickTarget(content: Content, state: GameState, k: Kind, rng: () => number): { zone: string | null; faction: string | null } | null {
  const zones = Object.keys(content.locations);
  const owned = (z: string) => state.zones[z]?.owner ?? null;
  const pick = <T,>(xs: T[]) => (xs.length ? xs[Math.floor(rng() * xs.length)]! : null);
  if (k.target === "all") return { zone: null, faction: null };
  if (k.target === "base") {
    const z = pick(zones.filter((id) => content.locations[id]?.kind === "base" && owned(id)));
    return z ? { zone: z, faction: owned(z) } : null;
  }
  if (k.target === "water") {
    const water = content.scenario.body?.thirst?.resource ?? "water";
    const z = pick(zones.filter((id) => (content.locations[id]?.yields[water] ?? 0) > 0));
    return z ? { zone: z, faction: owned(z) } : null;
  }
  if (k.target === "infested") {
    const top = [...zones].sort((a, b) => infestationOf(content, state, b) - infestationOf(content, state, a))[0];
    return top ? { zone: top, faction: owned(top) } : null;
  }
  // faction: 사람이 가장 많은 무리의 거점
  const f = Object.entries(state.factions).sort((a, b) => b[1].population - a[1].population)[0]?.[0];
  const base = f ? zones.find((id) => content.locations[id]?.kind === "base" && owned(id) === f) : undefined;
  return f ? { zone: base ?? null, faction: f } : null;
}

/** 주인공이 이 재난을 가까이서 겪는가 (전조가 보이고 소식이 바로 온다) */
export function disasterNear(content: Content, state: GameState, d: Disaster): boolean {
  if (!d.zone) return true;
  const me = state.characters[state.playerId];
  const here = state.playerZone;
  return here === d.zone || (!!here && (content.locations[here]?.adjacent ?? []).includes(d.zone)) || (!!me?.factionId && me.factionId === d.faction) || state.homes[state.playerId] === d.zone;
}

/** 하루가 지나면: 재난을 잡고, 때가 되면 덮치고, 지나가면 끝낸다 */
export function runDisasters(ctx: ToolContext, day: number): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const r = rules(content);
  if (!r?.kinds.length) return [];
  const state = store.getState();
  const d = state.disaster;
  if (d && d.phase === "omen" && day >= d.day) return strike(ctx, d, day);
  if (d && d.phase === "struck" && day > d.until) {
    store.append({ type: "disaster_ended" });
    return [];
  }
  if (d) return [];
  if (state.lastDisasterDay !== null && state.lastDisasterDay !== undefined && day - state.lastDisasterDay < r.min_gap_days) return [];
  const yearDays = (content.scenario.seasons?.list ?? []).reduce((n, s) => n + s.days, 0) || 80;
  if (rng() >= r.per_year / yearDays) return [];
  const at = day + r.warn_days;
  const season = seasonOfDay(content.scenario, at)?.id ?? "";
  const kinds = r.kinds.filter((k) => !k.seasons.length || k.seasons.includes(season));
  const k = kinds[Math.floor(rng() * kinds.length)];
  if (!k) return [];
  const target = pickTarget(content, state, k, rng);
  if (!target) return [];
  store.append({ type: "disaster_scheduled", kind: k.id, zone: target.zone, faction: target.faction, day: at });
  return [];
}

/** 재난이 덮친다. 대비한 만큼(prepared, 한 번에 25%, 최대 50%) 피해가 준다 */
function strike(ctx: ToolContext, d: Disaster, day: number): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const r = rules(content)!;
  const k = kindOf(content, d.kind)!;
  const m = 1 - 0.25 * Math.min(2, d.prepared);
  const state = store.getState();
  const factions = d.faction ? [d.faction] : k.target === "all" ? Object.keys(state.factions) : [];
  for (const f of factions) {
    const fs = store.getState().factions[f];
    if (!fs) continue;
    for (const [res, frac] of Object.entries(k.resources)) {
      const lost = Math.round((fs.resources[res] ?? 0) * frac * m);
      if (lost > 0) store.append({ type: "faction_resource_changed", factionId: f, resource: res, delta: -lost });
    }
    const dead = Math.round(fs.population * k.population * m);
    if (dead > 0) store.append({ type: "faction_population_changed", factionId: f, delta: -dead });
    if (k.morale) store.append({ type: "faction_morale_changed", factionId: f, delta: -k.morale });
  }
  let collapsed = false;
  if (d.zone) {
    if (k.fort) store.append({ type: "zone_fortified", zone: d.zone, delta: -k.fort });
    if (k.break_facilities) for (const id of store.getState().facilities?.[d.zone] ?? []) store.append({ type: "facility_broken", zone: d.zone, facility: id });
    if (k.infestation) {
      for (const z of [d.zone, ...(content.locations[d.zone]?.adjacent ?? [])]) {
        const level = Math.min(3, infestationOf(content, store.getState(), z) + k.infestation);
        store.append({ type: "infestation_changed", zone: z, level, cause: k.label });
      }
    }
    // 무너질 수도 (12-169): 거점을 덮친 재난이면 collapse_chance로 그 무리가 거점을 잃는다
    collapsed = k.collapse && content.locations[d.zone]?.kind === "base" && !!store.getState().zones[d.zone]?.owner && rng() < r.collapse_chance * m;
  }
  store.append({ type: "disaster_struck", until: day + k.recover_days, stall: k.stall_yields ? (d.zone ? [d.zone] : []) : [], collapsed });
  // 날씨를 바꾸는 재난(혹한)은 덮친 날부터 (12-169)
  if (k.weather) store.append({ type: "weather_set", day, weatherId: k.weather });
  if (collapsed && d.faction) store.append({ type: "faction_morale_changed", factionId: d.faction, delta: -2 });
  // 돌림병: 그 무리의 이름 있는 사람이 확률로 앓기 시작한다 (주인공도 그 무리면)
  const displays: ToolDisplayEvent[] = [];
  const disease = content.scenario.body?.disease?.track;
  if (k.disease && disease) {
    for (const c of Object.values(store.getState().characters)) {
      if (c.dead || !factions.includes(c.factionId)) continue;
      if (!content.npcs[c.id] && c.id !== store.getState().playerId) continue;
      if (rng() >= k.disease * m) continue;
      const ch = changeCondition(ctx, c.id, disease, 1, "disaster", k.label);
      if (c.id === store.getState().playerId && ch?.display) displays.push(ch.display);
    }
  }
  // 소식: 도시 전체가 듣는다. 가까이 있으면 직접 겪은 것으로
  const now = store.getState();
  const place = d.zone ? (content.locations[d.zone]?.name ?? d.zone) : "도시 전체";
  const who = d.faction ? (content.factions[d.faction]?.name ?? d.faction) : null;
  const fact = sentence(`${fill(k.news, { zone: place, faction: who ?? "" })}${collapsed && who ? `. ${josa(who, "은/는")} 거점을 잃었다` : ""}`);
  const near = disasterNear(content, now, d);
  store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact, source: near ? "seen" : "rumor", accuracy: near ? "exact" : "approximate", learnedAt: now.time } });
  // 결과에도 한 줄 (플레이 테스트 12: 재난이 알림 없이 생겼다)
  displays.push({ type: "belief", fact, sourceLabel: near ? "직접 봄" : "소문", note: `재난 소식 (${near ? "직접 겪음" : "소문"}): ${fact} ${near ? "그 자리의 장면으로 서술한다." : "누군가 전하는 말로 짧게 서술한다."}` });
  return displays;
}

/** 재난이 덮친 날의 날씨 (혹한 등): 그동안 날씨를 이것으로 */
export function disasterWeather(content: Content, state: GameState, day: number): string | null {
  const d = state.disaster;
  if (!d || d.phase !== "struck" || day > d.until) return null;
  return kindOf(content, d.kind)?.weather ?? null;
}

/** GM 상태의 줄: 전조(가까이 있을 때 낌새만), 재난 뒤 */
export function describeDisaster(content: Content, state: GameState): string[] {
  const d = state.disaster;
  if (!d) return [];
  const k = kindOf(content, d.kind);
  if (!k) return [];
  if (d.phase === "omen") return disasterNear(content, state, d) ? [`낌새 (무엇이 오는지는 모른다. 보이고 느껴지는 것만): ${k.omen}`] : [];
  const place = d.zone ? (content.locations[d.zone]?.name ?? d.zone) : "도시";
  return [`재난 뒤: ${place}에 ${k.label}. 사람들은 아직 그 뒤를 수습한다 (${k.aftermath})`];
}

/** 이야기 효과 disaster_prepare: 전조 동안 대비한다 */
export function prepareDisaster(ctx: ToolContext): string | null {
  const d = ctx.store.getState().disaster;
  if (!d || d.phase !== "omen") return null;
  ctx.store.append({ type: "disaster_prepared" });
  return "다가오는 것에 대비했다. 피해가 조금 줄 것이다.";
}
