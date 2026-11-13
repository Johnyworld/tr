import { tiesOf } from "../game/ties.ts";
import { activeCompanions, bondOf } from "../game/companions.ts";
import { isAwayCompanion } from "../engine/companionTools.ts";
import { factionPolicy } from "../sim/war.ts";
import { disposition } from "../sim/war.ts";
import type { Content, StoryletChoice, StoryletContent } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { activeMissionOf, commanderOf } from "../game/missions.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { dayOf, MINUTES_PER_DAY, segmentOf, type GameTime } from "../rules/time.ts";
import type { Rng } from "../rng.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { daysOfStock } from "../sim/war.ts";
import { fill } from "../text.ts";
import { seasonAt } from "../sim/season.ts";
import { occupationOf, occupationStep, occupationTag } from "../game/occupation.ts";

/**
 * 스토리렛 엔진 (기획서 10.3). 조건과 배역은 코드가 판정한다.
 * - 고정 스토리렛: 특정 인물·사건에 묶인 이야기 (repeatable: false)
 * - 템플릿 스토리렛: 배역과 자리({zone}, {scarce})를 세계 상태에서 채워 반복된다 (repeatable: true)
 * AI는 상황을 연출하고, 플레이어가 고른 선택지만 알린다. 효과는 콘텐츠가 정한 것만 코드가 적용한다.
 */

type CastRole = StoryletContent["cast"][string];

/** 이 배역에 맞는 살아 있는 NPC들 (id 순) */
export function castCandidates(state: GameState, content: Content, role: CastRole, picked: Record<string, string> = {}): string[] {
  const player = state.characters[state.playerId];
  if (!player) return [];
  const commander = commanderOf(state, content);
  const known = new Set(state.known[state.playerId] ?? []);
  if (role.companion) {
    const want = role.companion;
    return activeCompanions(state)
      .filter((id) => {
        const bond = bondOf(state, content, id);
        const template = state.characters[id]?.extra?.template;
        return (!want.kinds || (bond && want.kinds.includes(bond.kind))) && (!want.templates || (template && want.templates.includes(template)));
      })
      .filter((id) => !role.ids || role.ids.includes(id))
      .sort();
  }
  return Object.values(state.characters)
    .filter((c) => c.id !== state.playerId && !c.dead && !c.away && (content.npcs[c.id] || c.profile) && !state.squadOrders?.[c.id] && !isAwayCompanion(state, c.id))
    // 그 배역과 이어진 사람 (기획서 7.10: 적의 가족을 만나는 이야기)
    .filter((c) => !role.tie || tiesOf(state, content, picked[role.tie.of] ?? "").some((t) => t.other === c.id && (!role.tie!.kinds || role.tie!.kinds.includes(t.kind))))
    .filter((c) => !role.tie?.cross || c.factionId !== state.characters[picked[role.tie.of] ?? ""]?.factionId)
    // 포로는 captive: true인 배역만, 그리고 그 구역에서만 (갇힌 곳에서 마주친다)
    .filter((c) => (role.captive ? !!c.captive && c.captive.zone === state.playerZone : !c.captive))
    .filter((c) => !role.condition || bodyMatches(content, c.conditions[role.condition.track], role.condition))
    .filter((c) => !role.ids || role.ids.includes(c.id))
    .filter((c) => !role.commander || c.id === commander)
    .filter((c) => !role.faction || c.factionId === (role.faction === "own" ? player.factionId : role.faction === "zone_owner" ? (state.playerZone && state.zones[state.playerZone]?.owner) || "-" : role.faction === "captor" ? (player.captive?.by ?? "-") : role.faction))
    .filter((c) => !role.ranks || role.ranks.includes(c.rank))
    .filter((c) => !role.occupations || role.occupations.some((o) => (o === "same" ? player.occupation?.id : o) === c.occupation?.id && !!c.occupation))
    .filter((c) => !role.known || known.has(c.id))
    .filter((c) => role.trust_gte === undefined || (state.relations[c.id]?.[state.playerId] ?? NEUTRAL_RELATION).trust >= role.trust_gte)
    .map((c) => c.id)
    .sort();
}

/** 몸 상태 조건: 단계 순서로 at_least 이상, at_most 이하 */
function bodyMatches(content: Content, level: string | undefined, cond: { track: string; at_least?: string; at_most?: string }): boolean {
  const levels = content.scenario.condition_tracks.find((t) => t.id === cond.track)?.levels ?? [];
  const at = Math.max(0, levels.findIndex((l) => l.id === level));
  const idx = (id: string | undefined) => (id ? levels.findIndex((l) => l.id === id) : -1);
  if (cond.at_least && at < idx(cond.at_least)) return false;
  if (cond.at_most && idx(cond.at_most) >= 0 && at > idx(cond.at_most)) return false;
  return true;
}

/** 배경 배역의 후보 (기획서 12.6) */
function backgroundCast(state: GameState, content: Content, kind: "enemy" | "enemy_member" | "kin" | "sought" | "creditor" | "deserted"): string[] {
  const out: string[] = [];
  const membersOf = (f: string) => Object.values(state.characters).filter((c) => c.factionId === f && c.id !== state.playerId).map((c) => c.id);
  for (const { part, characterId } of state.background) {
    if (kind === "creditor" && part.kind === "debt") out.push(...membersOf(part.faction));
    if (kind === "deserted" && part.kind === "deserter") out.push(...membersOf(part.faction));
    if (kind === "enemy") {
      if (part.kind === "enemy" && content.npcs[part.target]) out.push(part.target);
      if (part.kind === "loss" && part.by && content.npcs[part.by]) out.push(part.by);
    }
    if (kind === "enemy_member") {
      // 원수가 인물이면 그 사람의 무리 (원수 본인은 빼고)
      const who = part.kind === "enemy" ? part.target : part.kind === "loss" ? part.by : null;
      const f = who && content.factions[who] ? who : who ? content.npcs[who]?.faction : null;
      if (f && content.factions[f]) out.push(...membersOf(f).filter((id) => id !== who));
    }
    if (kind === "kin" && part.kind === "kin_alive" && characterId) out.push(characterId);
    if (kind === "sought" && part.kind === "seeking" && characterId) out.push(characterId);
  }
  return [...new Set(out)].sort();
}

/** 엑스트라로 채울 배역의 자리표시 (발동하면 만든 인물 id로 바뀐다) */
export const EXTRA_CAST_PREFIX = "@extra:";

/** 배역을 고른다. 한 사람이 두 배역을 맡지 않는다. 채울 수 없으면 null */
export function pickCast(state: GameState, content: Content, storylet: StoryletContent, rng: Rng | null): Record<string, string> | null {
  const cast: Record<string, string> = {};
  const used = new Set<string>();
  for (const [key, role] of Object.entries(storylet.cast)) {
    // 이름 없는 인물 배역은 발동할 때 만든다 (storyletTools). 그때까지는 자리표시
    if (role.background) {
      const options = backgroundCast(state, content, role.background).filter((id) => {
        const c = state.characters[id];
        const here = state.companions.includes(id) || state.scene.present.includes(id) || (c?.extra ? c.extra.zone === state.playerZone : true);
        return c && !c.dead && !c.away && !c.captive && !used.has(id) && (!role.here || here);
      });
      if (options.length === 0) {
        if (role.optional) continue;
        return null;
      }
      const id = rng ? options[Math.floor(rng() * options.length)]! : options[0]!;
      cast[key] = id;
      used.add(id);
      continue;
    }
    if (role.recall) {
      const id = state.keptExtras[role.recall];
      const c = id ? state.characters[id] : undefined;
      // here: 지금 이 구역에 있는 사람만 (그 자리에 남겨 둔 사람, 12-54)
      const away = !!c?.extra && role.here && c.extra.zone !== state.playerZone && !state.companions.includes(id ?? "");
      if (!id || !c || c.dead || c.away || c.captive || used.has(id) || away) {
        if (role.optional) continue;
        return null;
      }
      cast[key] = id;
      used.add(id);
      continue;
    }
    if (role.extra) {
      cast[key] = `${EXTRA_CAST_PREFIX}${role.extra}`;
      continue;
    }
    const options = castCandidates(state, content, role, cast).filter((id) => !used.has(id));
    if (options.length === 0) {
      if (role.optional) continue; // 있으면 쓰는 배역: 비워 둔다
      return null;
    }
    const id = rng ? options[Math.floor(rng() * options.length)]! : options[0]!;
    cast[key] = id;
    used.add(id);
  }
  return cast;
}

/** 조건(when)이 지금(at) 맞는지 */
export function conditionsMet(state: GameState, content: Content, storylet: StoryletContent, at: GameTime): boolean {
  const w = storylet.when;
  const player = state.characters[state.playerId];
  if (!player || player.dead) return false;
  // 외딴곳에서는 그곳을 직접 적은 공통 이야기만 (기획서 9.12)
  const here = state.playerZone ? content.locations[state.playerZone] : undefined;
  if (here?.isolated && storylet.tags.includes(WORLD_TAG) && !w.zones?.includes(here.id)) return false;
  const own = state.factions[player.factionId];
  if (w.ranks && !w.ranks.includes(player.rank)) return false;
  if (w.segments && !w.segments.includes(segmentOf(at))) return false;
  if (w.seasons && !w.seasons.includes(seasonAt(content.scenario, at)?.id ?? "")) return false;
  if (w.weather && !w.weather.includes(state.weather?.id ?? "")) return false;
  if (w.day_gte !== undefined && dayOf(at) < w.day_gte) return false;
  if (w.day_lte !== undefined && dayOf(at) > w.day_lte) return false;
  if (w.merit_gte !== undefined && player.merit < w.merit_gte) return false;
  if (w.level_gte !== undefined && player.level < w.level_gte) return false;
  if (w.factions && !w.factions.includes(player.factionId || "none")) return false;
  if (w.captors && (!player.captive || !w.captors.includes(player.captive.by))) return false;
  if (w.own_people_captive !== undefined) {
    const any = !!player.factionId && Object.values(state.characters).some((c) => c.id !== player.id && !c.dead && c.factionId === player.factionId && c.captive && c.captive.by !== player.factionId);
    if (any !== w.own_people_captive) return false;
  }
  if (w.occupations && !w.occupations.includes(player.occupation?.id ?? "none")) return false;
  if (w.road_touches && (!state.lastRoute || !w.road_touches.some((z) => z === state.lastRoute!.from || z === state.lastRoute!.to))) return false;
  if (w.road_danger_gte !== undefined && routeDanger(content, state) < w.road_danger_gte) return false;
  if (w.road_danger_lte !== undefined && (!state.lastRoute || routeDanger(content, state) > w.road_danger_lte)) return false;
  if (w.at_loss_place && !state.background.some((e) => e.part.kind === "loss" && e.part.where && e.part.where === state.playerZone)) return false;
  if (w.occupation_step_gte !== undefined) {
    const occ = occupationOf(content, player);
    if (!occ || occupationStep(occ, player.occupation!.standing) < w.occupation_step_gte) return false;
  }
  if (w.zone_owner) {
    const owner = state.playerZone ? (state.zones[state.playerZone]?.owner ?? null) : null;
    const kind = owner === null ? "none" : owner === player.factionId ? "own" : "other";
    if (!w.zone_owner.includes(kind)) return false;
  }
  const debtOf = (f: string) => player.debts[f === "own" ? player.factionId : f] ?? 0;
  for (const [f, n] of Object.entries(w.debt_gte ?? {})) if (debtOf(f) < n) return false;
  for (const [f, n] of Object.entries(w.debt_lte ?? {})) if (debtOf(f) > n) return false;
  for (const d of w.dispositions ?? []) {
    const id = (x: string) =>
      x === "own" ? player.factionId : x === "captor" ? (player.captive?.by ?? "") : x === "zone_owner" ? ((state.playerZone && state.zones[state.playerZone]?.owner) || "") : x;
    if (!id(d.from) || !id(d.to)) return false;
    const v = disposition(content, id(d.from), id(d.to), state);
    if ((d.gte !== undefined && v < d.gte) || (d.lte !== undefined && v > d.lte)) return false;
  }
  if (w.zones && (!state.playerZone || !w.zones.includes(state.playerZone))) return false;
  if (w.own_territory !== undefined) {
    const mine = !!state.playerZone && state.zones[state.playerZone]?.owner === player.factionId;
    if (mine !== w.own_territory) return false;
  }
  if (!itemFlagsMet(state, w)) return false;
  for (const [id, n] of Object.entries(w.clock_gte ?? {})) if ((state.clocks[id]?.filled ?? -Infinity) < n) return false;
  for (const [id, n] of Object.entries(w.clock_lte ?? {})) if ((state.clocks[id]?.filled ?? Infinity) > n) return false;
  if (w.own_morale_lte !== undefined && (!own || own.morale > w.own_morale_lte)) return false;
  if (w.zone_noise_gte !== undefined) {
    const noise = state.playerZone ? state.zoneNoise?.[state.playerZone] : undefined;
    if (!noise || noise.day !== dayOf(at) || noise.level < w.zone_noise_gte) return false;
  }
  if (w.own_policy) {
    if (!own) return false;
    const now = new Map(factionPolicy(content, own).map(({ topic, option }) => [topic.id, option.id]));
    for (const [topic, options] of Object.entries(w.own_policy)) if (!options.includes(now.get(topic) ?? "")) return false;
  }
  if (w.own_food_days_lte !== undefined) {
    const resource = content.scenario.war?.ration.resource;
    if (!own || !resource || daysOfStock(content, own, resource) > w.own_food_days_lte) return false;
  }
  if (w.harm_at_least) {
    const track = harmTrack(content.scenario);
    const index = (id: string | undefined) => track.levels.findIndex((l) => l.id === id);
    if (index(player.conditions[track.id]) < index(w.harm_at_least)) return false;
  }
  for (const [trackId, levelId] of Object.entries(w.conditions_at_least ?? {})) {
    const levels = content.scenario.condition_tracks.find((t) => t.id === trackId)?.levels ?? [];
    const at = levels.findIndex((l) => l.id === player.conditions[trackId]);
    if (at < 0 || levels[at]!.hidden || at < levels.findIndex((l) => l.id === levelId)) return false;
  }
  if (w.mission_active !== undefined && !!activeMissionOf(state.missions, state.playerId) !== w.mission_active) return false;
  if (w.war_news_within_hours !== undefined) {
    const since = at - w.war_news_within_hours * 60;
    if (!(state.beliefs[state.playerId] ?? []).some((b) => b.topic === "war" && b.learnedAt >= since)) return false;
  }
  return true;
}

type ItemFlagConditions = NonNullable<StoryletChoice["when"]>;

/** 플래그·물건 조건 (이야기와 선택지가 함께 쓴다) */
export function itemFlagsMet(state: GameState, w: ItemFlagConditions): boolean {
  const player = state.characters[state.playerId];
  if (!player) return false;
  const flags = new Set(state.flags[state.playerId] ?? []);
  const has = (i: string) => (player.inventory[i] ?? 0) > 0;
  if (w.flags_all && !w.flags_all.every((f) => flags.has(f))) return false;
  if (w.flags_any && !w.flags_any.some((f) => flags.has(f))) return false;
  if (w.flags_none && w.flags_none.some((f) => flags.has(f))) return false;
  if (w.has_items && !w.has_items.every(has)) return false;
  if (w.has_items_any && !w.has_items_any.some(has)) return false;
  if (w.equipped) {
    const worn = Object.values(player.equipped ?? {}).filter((id): id is string => !!id && has(id));
    if (!w.equipped.some((i) => worn.includes(i))) return false;
  }
  return true;
}

/**
 * 선택지를 지금 고를 수 있는지: 선택지의 조건, 그리고 내놓을 물건(take_item)을 지녔는지.
 * 판정이 붙은 선택지는 어느 결과에서든 내놓을 물건을 모두 지녀야 한다 (굴린 뒤에 막히지 않게)
 */
export function choiceAvailable(state: GameState, choice: StoryletChoice, cast: Record<string, string> = {}): boolean {
  if (choice.when && !itemFlagsMet(state, choice.when)) return false;
  // 있으면 쓰는 배역이 비었으면 그 배역을 쓰는 선택지는 빠진다
  if (choice.when?.cast && !choice.when.cast.every((k) => !!cast[k])) return false;
  if (choice.when?.cast_empty && choice.when.cast_empty.some((k) => !!cast[k])) return false;
  if (choice.when?.factions && !choice.when.factions.includes(state.characters[state.playerId]?.factionId || "none")) return false;
  if (choice.when?.in_faction !== undefined && !!state.characters[state.playerId]?.factionId !== choice.when.in_faction) return false;
  const player = state.characters[state.playerId];
  if (!player) return false;
  const effects = choice.outcomes ? [...choice.outcomes.success, ...choice.outcomes.partial, ...choice.outcomes.miss] : choice.effects;
  const need: Record<string, number> = {};
  for (const e of effects) if ("take_item" in e) need[e.take_item.item] = Math.max(need[e.take_item.item] ?? 0, e.take_item.quantity);
  return Object.entries(need).every(([item, n]) => (player.inventory[item] ?? 0) >= n);
}

/** 어느 시나리오(역할)에서나 발동하는 스토리렛 태그 */
export const WORLD_TAG = "world";

/** 지금 발동할 수 있는 스토리렛 (역할 태그, 반복·쿨다운, 조건, 배역) */
export function eligibleStorylets(state: GameState, content: Content, at: GameTime = state.time): StoryletContent[] {
  const roleTags = new Set(content.roles[state.roleId]?.storylet_tags ?? []);
  // 갇혀 있으면 갇힌 동안의 이야기만, 아니면 그 이야기는 열리지 않는다 (12-55)
  const captivityTag = content.scenario.captivity?.tag;
  const captive = !!state.characters[state.playerId]?.captive;
  // 직분의 이야기 (기획서 12.6)
  const occ = occupationOf(content, state.characters[state.playerId]);
  if (occ) roleTags.add(occupationTag(occ));
  return Object.values(content.storylets)
    // 태그가 없거나 world면 어느 시나리오에서나, 아니면 역할의 태그와 겹칠 때만
    .filter((s) => (captivityTag && s.tags.includes(captivityTag) ? captive : !captive))
    .filter((s) => (captivityTag && s.tags.includes(captivityTag)) || s.tags.length === 0 || s.tags.some((t) => t === WORLD_TAG || roleTags.has(t)))
    .filter((s) => {
      const log = state.storyletLog[s.id];
      if (!log) return true;
      if (!s.repeatable) return false;
      return at - log.lastFiredAt >= s.cooldown_days * MINUTES_PER_DAY;
    })
    .filter((s) => conditionsMet(state, content, s, at))
    .filter((s) => pickCast(state, content, s, null) !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 다음 스토리렛을 열 수 있는 때인지 (진행 중인 것·전투가 없고, 간격이 지났다) */
export function storyletWindowOpen(state: GameState, content: Content, at: GameTime): boolean {
  return storyletWindow(state, content, at) === "open";
}

/**
 * 이야기를 열 수 있는 때: open(아무 이야기나) / urgent_only(이야기 사이 간격 안이지만 급한 일은 연다) / closed.
 * 급한 이야기(urgent)는 그 자리·그 시각에만 맞는 일이 많아, 간격 때문에 놓치지 않게 한다
 */
export function storyletWindow(state: GameState, content: Content, at: GameTime): "open" | "urgent_only" | "closed" {
  if (state.activeStorylet || state.battle) return "closed";
  const pacing = content.scenario.storylet_pacing;
  // 지금 캐릭터의 이야기가 막 시작됐으면 조금 기다린다
  if (at - state.runStartedAt < pacing.first_after_hours * 60) return "closed";
  if (state.lastStoryletAt === null || state.lastStoryletAt < state.runStartedAt) return "open";
  return at - state.lastStoryletAt >= pacing.min_gap_hours * 60 ? "open" : "urgent_only";
}

/** 무게로 하나 고른다 */
/** 시나리오에 묶인 이야기는 도시 공통 이야기(world)보다 이만큼 자주 고른다 (공통 이야기가 늘어도 시나리오 이야기가 묻히지 않게) */
export const ROLE_STORY_BOOST = 3;

export function pickStorylet(candidates: readonly StoryletContent[], rng: Rng): StoryletContent | null {
  const weightOf = (s: StoryletContent) => s.weight * (s.tags.includes(WORLD_TAG) ? 1 : ROLE_STORY_BOOST);
  const total = candidates.reduce((n, s) => n + weightOf(s), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const s of candidates) {
    r -= weightOf(s);
    if (r < 0) return s;
  }
  return candidates.at(-1) ?? null;
}

/** 문장 자리 채우기: 배역 이름, {zone} 지금 구역, {scarce} 우리 무리에서 가장 모자란 자원 */
export function storyletVars(state: GameState, content: Content, cast: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  // 배역은 주인공이 부르는 말로 (이름을 모르면 호칭, 기획서 6.3)
  for (const [key, id] of Object.entries(cast)) vars[key] = playerCalls(state, content, id);
  vars.zone = (state.playerZone && content.locations[state.playerZone]?.name) || "거점";
  // 길 위의 이야기: 떠나온 곳과 가는 곳 (12-53)
  if (state.lastRoute) {
    vars.from = content.locations[state.lastRoute.from]?.name ?? state.lastRoute.from;
    vars.to = content.locations[state.lastRoute.to]?.name ?? state.lastRoute.to;
  }
  const player = state.characters[state.playerId];
  const own = player ? state.factions[player.factionId] : undefined;
  const war = content.scenario.war;
  if (own && war) {
    const scarce = content.scenario.resources
      .filter((r) => (war.upkeep[r.id] ?? 0) > 0)
      .map((r) => ({ label: r.label, days: daysOfStock(content, own, r.id) }))
      .sort((a, b) => a.days - b.days)[0];
    if (scarce) vars.scarce = scarce.label;
  }
  vars.scarce ??= content.scenario.resources[0]?.label ?? "물자";
  return vars;
}

export function fillStorylet(text: string, vars: Record<string, string>): string {
  return fill(text, vars);
}

/** 지금 오간 길의 위험: 두 구역 중 높은 쪽 (12-53) */
export function routeDanger(content: Content, state: GameState): number {
  if (!state.lastRoute) return 0;
  return Math.max(content.locations[state.lastRoute.from]?.danger ?? 0, content.locations[state.lastRoute.to]?.danger ?? 0);
}

/** 길 위의 이야기 후보: 태그가 맞고, 아직 안 열렸거나 쿨다운이 지났고, 조건과 배역이 맞는 것 */
export function roadStorylets(state: GameState, content: Content, tag: string): StoryletContent[] {
  return Object.values(content.storylets)
    .filter((s) => s.tags.includes(tag))
    .filter((s) => {
      const log = state.storyletLog[s.id];
      return !log || (s.repeatable && state.time - log.lastFiredAt >= s.cooldown_days * MINUTES_PER_DAY);
    })
    .filter((s) => conditionsMet(state, content, s, state.time))
    .filter((s) => pickCast(state, content, s, null) !== null);
}
