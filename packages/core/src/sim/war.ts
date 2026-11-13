import type { Content, FactionContent } from "../content/schemas.ts";
import type { Clash, ClockState, FactionState } from "../game/state.ts";
import type { Rng } from "../rng.ts";

/**
 * 세력 단위 전쟁 시뮬레이션 (기획서 9.2: "보이지만 지휘하지 않는다").
 * 하루에 한 번, 코드가 소모·생산·클락·교전을 계산한다. 결정적이다 (같은 RNG면 같은 결과).
 * AI는 결과를 바꾸지 못하고, 플레이어는 배급과 소식으로 겪는다.
 *
 * 하루의 순서:
 * 1. 생산: 소유 구역의 산출을 더한다
 * 2. 소모: 인원수만큼 줄어든다. 생존 자원이 모자라면 사기가 떨어지고 사람이 죽는다
 * 3. 세력 클락: 한 칸씩 찬다. 다 차면 목표 구역을 총공격한다
 * 4. 교전: 공격 성향이 있는 세력이 확률로 적대 세력의 인접 구역을 습격·교전·공격하거나 빈 구역을 차지한다
 * 5. 결속과 회복: 사기와 결속이 바닥이면 이탈자가 생긴다. 굶지 않고 별일 없으면
 *    사기가 시작값 쪽으로 돌아오고, 남은 사람 중에서 전투원을 키우고, 가끔 피란민이 합류한다 (끝없는 세계)
 */

export type ZoneState = { owner: string | null };

export type WarWorld = {
  factions: Record<string, FactionState>;
  zones: Record<string, ZoneState>;
  clocks: Record<string, ClockState>;
};

/** 교전 하나의 명세 (아직 결과가 정해지지 않은 것) */
export type ClashSpec = { kind: "raid" | "skirmish" | "assault"; attacker: string; defender: string; zone: string; plan?: string };

export type WarDayResult = WarWorld & {
  clashes: Clash[];
  /** 오늘 태도가 바뀐 세력 (shift 클락이 찼다) */
  shifts: { clockId: string; factionId: string; to: string; news: string }[];
  /** defer로 미뤄 둔 교전 (전투 장면으로 열 수 있는 것) */
  deferred: ClashSpec[];
};

export type WarDayOptions = {
  /** 이 날의 계절 배수 (소모·산출). 없으면 1 */
  season?: { upkeep: Record<string, number>; yields: Record<string, number> } | null;
  /** true면 이 교전을 계산하지 않고 미룬다 (플레이어가 그 자리에 있을 때) */
  defer?: (spec: ClashSpec) => boolean;
};

/** 이 세력이 저 세력을 적으로 보는지 (태도 -2 이하) */
export const HOSTILE = -2;

/** 교전에 내보내는 병력 비율 */
const COMMIT: Record<Clash["kind"], number> = { raid: 0.15, skirmish: 0.2, assault: 0.35, occupy: 0.1 };
const PLAN_COMMIT = 0.5;
const DEFENSE_COMMIT = 0.2;
/** 방침이 아무리 지키자고 해도 전투원의 이 비율까지만 지킨다 */
const DEFENSE_COMMIT_MAX = 0.4;
const BASE_DEFENSE_BONUS = 1.5;
/** 탄약이 모자라면 전투력이 이만큼으로 준다 */
const NO_AMMO_FACTOR = 0.6;
/** 습격에 성공하면 상대 자원의 이 비율을 빼앗는다 (내보낸 1명당 10까지) */
const LOOT_RATE = 0.05;
const LOOT_PER_RAIDER = 10;
const DESERTION_CHANCE = 0.5;
const TRAINING_CHANCE = 0.3;
const REFUGEE_CHANCE = 0.08;
/** 공격 종류 가중치 */
const KIND_WEIGHT: Record<Clash["kind"], number> = { occupy: 3, raid: 3, skirmish: 2, assault: 1 };

export function initialWarWorld(content: Content): WarWorld {
  const factions: Record<string, FactionState> = {};
  for (const f of Object.values(content.factions)) {
    factions[f.id] = {
      population: f.population,
      combatants: f.combatants,
      resources: Object.fromEntries(content.scenario.resources.map((r) => [r.id, Math.round(f.resources[r.id] ?? 0)])),
      morale: f.morale,
      cohesion: f.cohesion,
      disposition: { ...f.disposition },
    };
  }
  const zones: Record<string, ZoneState> = {};
  for (const loc of Object.values(content.locations)) zones[loc.id] = { owner: loc.owner };
  const clocks: Record<string, ClockState> = {};
  for (const f of Object.values(content.factions)) {
    for (const plan of f.plans) clocks[plan.id] = { factionId: f.id, label: plan.label, target: plan.target ?? "", filled: 0, max: plan.days };
  }
  return { factions, zones, clocks };
}

/** 인접 구역 (한쪽에만 적혀 있어도 양쪽으로 본다) */
export function neighbors(content: Content, zoneId: string): string[] {
  const out = new Set(content.locations[zoneId]?.adjacent ?? []);
  for (const loc of Object.values(content.locations)) if (loc.adjacent.includes(zoneId)) out.add(loc.id);
  return [...out].sort();
}

/** from 세력이 to 세력을 보는 지금 태도. 세계 상태에 있으면 그것, 없으면 콘텐츠의 시작값 */
export function disposition(content: Content, from: string, to: string, world?: { factions: Record<string, FactionState> } | null): number {
  return world?.factions[from]?.disposition?.[to] ?? content.factions[from]?.disposition[to] ?? 0;
}

/** shift 클락이 찼다: 정해 둔 태도로 바꾼다. to가 strongest면 그때 전투원이 가장 많은 다른 세력 */
function applyShift(world: WarWorld, content: Content, factionId: string, clockId: string, plan: { shift?: { from?: string; to: string; value: number }[]; news?: string }) {
  const strongest = Object.entries(world.factions)
    .filter(([id, f]) => id !== factionId && f.combatants > 0)
    .sort(([a, x], [b, y]) => y.combatants - x.combatants || a.localeCompare(b))[0]?.[0];
  let target = "";
  for (const s of plan.shift ?? []) {
    const to = s.to === "strongest" ? strongest : s.to;
    const from = s.from ?? factionId;
    if (!to || !world.factions[from]) continue;
    target ||= to;
    world.factions[from]!.disposition = { ...(world.factions[from]!.disposition ?? {}), [to]: s.value };
  }
  const name = (id: string) => content.factions[id]?.name ?? id;
  const news = (plan.news ?? "{faction}의 태도가 달라졌다는 말이 돈다").replaceAll("{faction}", name(factionId)).replaceAll("{to}", target ? name(target) : "");
  return { clockId, factionId, to: target, news };
}

/** 세력 클락 정의 (콘텐츠) */
function planOf(content: Content, clockId: string) {
  for (const f of Object.values(content.factions)) {
    const p = f.plans.find((x) => x.id === clockId);
    if (p) return p;
  }
  return undefined;
}

type PolicyTopic = NonNullable<Content["scenario"]["command"]>["policies"][number];
type PolicyOption = PolicyTopic["options"][number];

/** 이 무리의 지금 방침 (주제마다 선택지, 기획서 9.11). 정하지 않은 주제는 시나리오의 default */
export function factionPolicy(content: Content, faction: { policy?: Record<string, string> } | undefined): { topic: PolicyTopic; option: PolicyOption }[] {
  const out: { topic: PolicyTopic; option: PolicyOption }[] = [];
  for (const topic of content.scenario.command?.policies ?? []) {
    const id = faction?.policy?.[topic.id] ?? topic.default;
    const option = topic.options.find((o) => o.id === id) ?? topic.options.find((o) => o.id === topic.default);
    if (option) out.push({ topic, option });
  }
  return out;
}

/** 방침이 전쟁 틱에 주는 배수: 소모(자원별), 공격 성향, 지키는 병력. 사기 변화는 따로 */
function policyEffects(content: Content, faction: FactionState | undefined) {
  const upkeep: Record<string, number> = {};
  let aggression = 1;
  let defense = 1;
  const morale: { delta: number; chance: number }[] = [];
  for (const { option } of factionPolicy(content, faction)) {
    for (const [r, m] of Object.entries(option.upkeep)) upkeep[r] = (upkeep[r] ?? 1) * m;
    aggression *= option.aggression;
    defense *= option.defense;
    if (option.morale) morale.push(option.morale);
  }
  return { upkeep, aggression, defense, morale };
}

/** 무리 사람이 받는 배급 단계: 창고가 며칠 치 남았는지로 정하고, 방침(ration_shift)만큼 옮긴다 */
export function rationLevel(content: Content, faction: FactionState) {
  const war = content.scenario.war!;
  const levels = war.ration.levels;
  const days = daysOfStock(content, faction, war.ration.resource);
  const base = Math.max(0, levels.findIndex((l) => days >= l.min_days));
  const at = days >= (levels.at(-1)?.min_days ?? 0) ? base : levels.length - 1;
  const shift = factionPolicy(content, faction).reduce((n, { option }) => n + option.ration_shift, 0);
  return levels[Math.max(0, Math.min(levels.length - 1, at + shift))]!;
}

/** 무리의 자원이 며칠 치 남았는지 (소모가 없으면 Infinity) */
export function daysOfStock(content: Content, faction: FactionState, resource: string): number {
  const perDay = (content.scenario.war?.upkeep[resource] ?? 0) * faction.population;
  if (perDay <= 0) return Infinity;
  return (faction.resources[resource] ?? 0) / perDay;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const randInt = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function pickWeighted<T>(rng: Rng, items: readonly { item: T; weight: number }[]): T | null {
  const total = items.reduce((n, x) => n + x.weight, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const x of items) {
    r -= x.weight;
    if (r < 0) return x.item;
  }
  return items.at(-1)!.item;
}

/** 하루를 시뮬레이션한다. 입력은 바꾸지 않고 새 값을 돌려준다 */
export function simulateWarDay(world: WarWorld, content: Content, rng: Rng, options: WarDayOptions = {}): WarDayResult {
  const war = content.scenario.war;
  const next: WarWorld = structuredClone(world);
  const clashes: Clash[] = [];
  const deferred: ClashSpec[] = [];
  if (!war) return { ...next, clashes, deferred, shifts: [] };
  const fightOrDefer = (spec: ClashSpec) => {
    if (options.defer?.(spec)) deferred.push(spec);
    else clashes.push(fight(next, content, rng, spec.kind, spec.attacker, spec.defender, spec.zone, spec.plan));
  };

  const alive = Object.keys(next.factions)
    .filter((id) => next.factions[id]!.population > 0)
    .sort();
  const troubled = new Set<string>();

  // 1-2. 생산과 소모. 산출은 일할 사람 수에 따라 줄고 는다 (시작 인원 대비, 0.7 ~ 1.2배)
  for (const id of alive) {
    const f = next.factions[id]!;
    const startPop = content.factions[id]?.population ?? f.population;
    const workforce = clamp(f.population / Math.max(1, startPop), 0.7, 1.2);
    for (const loc of Object.values(content.locations)) {
      if (next.zones[loc.id]?.owner !== id) continue;
      for (const [r, amount] of Object.entries(loc.yields)) {
        f.resources[r] = (f.resources[r] ?? 0) + Math.round((amount ?? 0) * (options.season?.yields[r] ?? 1) * workforce);
      }
    }
    let short = false;
    let hardship = false;
    for (const [r, rate] of Object.entries(war.upkeep)) {
      const need = Math.ceil(rate * (options.season?.upkeep[r] ?? 1) * (policyEffects(content, f).upkeep[r] ?? 1) * f.population);
      const have = f.resources[r] ?? 0;
      if (have < need && war.vital.includes(r)) short = true;
      if (have < need && war.hardship.includes(r)) hardship = true;
      f.resources[r] = Math.max(0, have - need);
    }
    if (hardship && !short && rng() < 0.3) {
      // 추위 같은 고생: 사람이 죽지는 않지만 분위기가 가라앉는다
      troubled.add(id);
      f.morale = clamp(f.morale - 1, -3, 3);
    }
    if (short) {
      troubled.add(id);
      f.morale = clamp(f.morale - 1, -3, 3);
      const dead = Math.max(1, Math.ceil(f.population * 0.01));
      f.population = Math.max(0, f.population - dead);
      f.combatants = Math.min(f.combatants, f.population);
      if (f.morale <= -2) f.cohesion = clamp(f.cohesion - 1, -3, 3);
    }
  }

  // 2-1. 교역 방침 (기획서 9.11): 서로 등을 돌리지 않았고 양쪽 창고에 있으면 바꾼다
  for (const id of alive) {
    for (const { option } of factionPolicy(content, next.factions[id])) {
      const t = option.trade;
      if (!t) continue;
      const partner = t.partner === id ? t.fallback_partner : t.partner;
      if (!partner || partner === id || !alive.includes(partner)) continue;
      const me = next.factions[id]!;
      const them = next.factions[partner]!;
      if (disposition(content, id, partner, next) < t.min_disposition || disposition(content, partner, id, next) < t.min_disposition) continue;
      const enough = (f: FactionState, need: Record<string, number>) => Object.entries(need).every(([r, n]) => (f.resources[r] ?? 0) >= n);
      if (!enough(me, t.give) || !enough(them, t.get)) continue;
      for (const [r, n] of Object.entries(t.give)) {
        me.resources[r] = (me.resources[r] ?? 0) - n;
        them.resources[r] = (them.resources[r] ?? 0) + n;
      }
      for (const [r, n] of Object.entries(t.get)) {
        them.resources[r] = (them.resources[r] ?? 0) - n;
        me.resources[r] = (me.resources[r] ?? 0) + n;
      }
    }
  }

  // 3. 세력 클락
  const planned: { clockId: string; clock: ClockState }[] = [];
  const shifts: WarDayResult["shifts"] = [];
  for (const [clockId, clock] of Object.entries(next.clocks).sort(([a], [b]) => a.localeCompare(b))) {
    if (!alive.includes(clock.factionId)) continue;
    const plan = planOf(content, clockId);
    if (plan?.kind === "shift") {
      // 태도가 바뀌는 계획은 한 번 일어나고 끝난다 (찬 채로 둔다)
      if (clock.filled >= clock.max) continue;
      clock.filled += 1;
      if (clock.filled >= clock.max) shifts.push(applyShift(next, content, clock.factionId, clockId, plan));
      continue;
    }
    clock.filled += 1;
    if (clock.filled >= clock.max) {
      clock.filled = 0; // 끝난 클락은 다시 시작한다 (기획서 10.4)
      planned.push({ clockId, clock });
    }
  }
  for (const { clockId, clock } of planned) {
    const zoneId = clock.target || frontierTarget(next, content, clock.factionId);
    if (!zoneId) continue; // 칠 곳이 없으면 다음을 기다린다
    const owner = next.zones[zoneId]?.owner ?? null;
    const target = content.locations[zoneId];
    if (!target || owner === clock.factionId) continue;
    if (owner === null) clashes.push(occupy(next, clock.factionId, zoneId, clockId));
    else if (disposition(content, clock.factionId, owner, next) <= HOSTILE && target.kind !== "base") {
      fightOrDefer({ kind: "assault", attacker: clock.factionId, defender: owner, zone: zoneId, plan: clockId });
    }
  }

  // 4. 교전
  for (const attacker of alive) {
    const profile = content.factions[attacker];
    if (!profile || profile.aggression <= 0) continue;
    if (next.factions[attacker]!.combatants <= 0) continue;
    const aggression = profile.aggression * policyEffects(content, next.factions[attacker]).aggression;
    if (rng() >= Math.min(0.9, aggression * war.attack_chance_per_aggression)) continue;
    const options = attackOptions(next, content, profile);
    const choice = pickWeighted(rng, options.map((o) => ({ item: o, weight: KIND_WEIGHT[o.kind] })));
    if (!choice) continue;
    if (choice.kind === "occupy") clashes.push(occupy(next, attacker, choice.zone));
    else fightOrDefer({ kind: choice.kind, attacker, defender: choice.defender!, zone: choice.zone });
  }

  // 5. 결속과 회복
  for (const id of alive) {
    const f = next.factions[id]!;
    const start = content.factions[id];
    // 무리 방침의 사기 변화 (배급을 줄이면 가라앉고, 늘리면 오른다)
    for (const m of policyEffects(content, f).morale) {
      if (m.delta !== 0 && rng() < m.chance) f.morale = clamp(f.morale + m.delta, -3, 3);
    }
    if (f.morale <= -2 && f.cohesion <= -2 && f.combatants > 0) {
      if (rng() < DESERTION_CHANCE) lose(f, Math.max(1, Math.ceil(f.combatants * 0.03)));
    }
    if (!start || troubled.has(id)) continue;
    const beaten = clashes.some((c) => c.success && c.defender === id);
    if (!beaten && f.morale !== start.morale && rng() < 0.2) f.morale += Math.sign(start.morale - f.morale);
    if (!beaten && f.cohesion < start.cohesion && f.morale >= 0 && rng() < 0.1) f.cohesion += 1;
    // 전투원 비율이 처음보다 낮으면 남은 사람 중에서 키운다
    if (f.combatants < Math.round((f.population * start.combatants) / start.population) && rng() < TRAINING_CHANCE) f.combatants += 1;
    if (f.morale >= 0 && daysOfStock(content, f, war.ration.resource) >= 14 && rng() < REFUGEE_CHANCE) f.population += 1;
  }

  return { ...next, clashes, deferred, shifts };
}

/** 미뤄 둔 교전을 화면 밖에서 계산한다 (플레이어가 자리를 떴을 때) */
export function resolveClash(world: WarWorld, content: Content, rng: Rng, spec: ClashSpec): { world: WarWorld; clash: Clash } {
  const next = structuredClone(world);
  const zoneOwner = next.zones[spec.zone]?.owner;
  // 그사이 구역 주인이 바뀌었으면 싸움이 일어나지 않은 것으로 본다
  if (zoneOwner !== spec.defender || !next.factions[spec.attacker] || !next.factions[spec.defender]) {
    return { world: next, clash: { ...spec, success: false, attackerLosses: 0, defenderLosses: 0 } };
  }
  return { world: next, clash: fight(next, content, rng, spec.kind, spec.attacker, spec.defender, spec.zone, spec.plan) };
}

/**
 * 전투 장면이 끝난 뒤 세력 상태에 결과를 적용한다 (사상자, 약탈, 점령, 사기, 탄약·의약품 소모).
 * 승패와 사상자는 전투 장면이 정한 값을 그대로 쓴다.
 */
export function applyBattleOutcome(
  world: WarWorld,
  content: Content,
  spec: ClashSpec,
  outcome: { success: boolean; attackerLosses: number; defenderLosses: number },
): { world: WarWorld; clash: Clash } {
  const war = content.scenario.war!;
  const next = structuredClone(world);
  const a = next.factions[spec.attacker]!;
  const d = next.factions[spec.defender]!;
  const attackerLosses = Math.min(a.combatants, outcome.attackerLosses);
  const defenderLosses = Math.min(d.combatants, outcome.defenderLosses);
  lose(a, attackerLosses);
  lose(d, defenderLosses);
  for (const f of [a, d]) f.resources[war.ammo] = Math.max(0, (f.resources[war.ammo] ?? 0) - war.ammo_per_clash);
  a.resources[war.medicine] = Math.max(0, (a.resources[war.medicine] ?? 0) - attackerLosses * war.medicine_per_casualty);
  d.resources[war.medicine] = Math.max(0, (d.resources[war.medicine] ?? 0) - defenderLosses * war.medicine_per_casualty);
  const committed = Math.max(1, Math.round(a.combatants * (spec.plan ? PLAN_COMMIT : COMMIT[spec.kind])));
  const clash: Clash = { ...spec, success: outcome.success, attackerLosses, defenderLosses };
  applySpoils(next, spec.kind, a, d, spec.attacker, spec.defender, spec.zone, outcome.success, committed, clash);
  return { world: next, clash };
}

/** 병력 규모: 내보내는 공격 병력과 지키는 병력 */
export function clashForces(world: WarWorld, spec: ClashSpec, content?: Content): { attackers: number; defenders: number } {
  const a = world.factions[spec.attacker]!;
  const d = world.factions[spec.defender]!;
  return {
    attackers: Math.max(1, Math.round(a.combatants * (spec.plan ? PLAN_COMMIT : COMMIT[spec.kind]))),
    defenders: Math.max(1, Math.round(d.combatants * DEFENSE_COMMIT * (content ? defenseOf(content, d) : 1))),
  };
}

/**
 * 맞닿은 적대 세력의 구역 중 반격할 곳: 원래 우리 땅이던 곳 먼저, 그다음 산출이 많은 곳.
 * 빈 땅은 그냥 차지한다. 거점은 고르지 않는다
 */
export function frontierTarget(world: WarWorld, content: Content, factionId: string): string | null {
  const mine = Object.keys(world.zones).filter((z) => world.zones[z]!.owner === factionId);
  const candidates = [...new Set(mine.flatMap((z) => neighbors(content, z)))]
    .filter((z) => content.locations[z]?.kind !== "base")
    .filter((z) => {
      const owner = world.zones[z]?.owner ?? null;
      return owner === null || (owner !== factionId && disposition(content, factionId, owner, world) <= HOSTILE);
    });
  const value = (z: string) => Object.values(content.locations[z]?.yields ?? {}).reduce<number>((n, x) => n + (x ?? 0), 0);
  const lost = (z: string) => Number(content.locations[z]?.owner === factionId);
  candidates.sort((a, b) => lost(b) - lost(a) || value(b) - value(a) || a.localeCompare(b));
  return candidates[0] ?? null;
}

type AttackOption = { kind: Clash["kind"]; defender: string | null; zone: string };

/** 공격 후보: 내 구역과 맞닿은 적대 세력의 구역, 또는 빈 구역 */
function attackOptions(world: WarWorld, content: Content, attacker: FactionContent): AttackOption[] {
  const mine = Object.keys(world.zones)
    .filter((z) => world.zones[z]!.owner === attacker.id)
    .sort();
  const frontier = new Set(mine.flatMap((z) => neighbors(content, z)));
  const options: AttackOption[] = [];
  for (const zone of [...frontier].sort()) {
    const owner = world.zones[zone]?.owner ?? null;
    if (owner === attacker.id) continue;
    if (owner === null) {
      options.push({ kind: "occupy", defender: null, zone });
      continue;
    }
    if (disposition(content, attacker.id, owner, world) > HOSTILE) continue;
    if ((world.factions[owner]?.population ?? 0) <= 0) continue;
    options.push({ kind: "raid", defender: owner, zone }, { kind: "skirmish", defender: owner, zone });
    if (content.locations[zone]?.kind !== "base") options.push({ kind: "assault", defender: owner, zone });
  }
  return options;
}

function occupy(world: WarWorld, attacker: string, zone: string, plan?: string): Clash {
  world.zones[zone] = { owner: attacker };
  return { kind: "occupy", attacker, defender: null, zone, success: true, attackerLosses: 0, defenderLosses: 0, ...(plan ? { plan } : {}) };
}

function fight(
  world: WarWorld,
  content: Content,
  rng: Rng,
  kind: Exclude<Clash["kind"], "occupy">,
  attackerId: string,
  defenderId: string,
  zone: string,
  plan?: string,
): Clash {
  const war = content.scenario.war!;
  const a = world.factions[attackerId]!;
  const d = world.factions[defenderId]!;
  const committed = Math.max(1, Math.round(a.combatants * (plan ? PLAN_COMMIT : COMMIT[kind])));
  const defenders = Math.max(1, Math.round(d.combatants * DEFENSE_COMMIT * defenseOf(content, d)));
  const power = (n: number, f: FactionState) => n * (1 + 0.1 * f.morale) * ((f.resources[war.ammo] ?? 0) >= war.ammo_per_clash ? 1 : NO_AMMO_FACTOR);
  const attack = power(committed, a);
  const defense = power(defenders, d) * (content.locations[zone]?.kind === "base" ? BASE_DEFENSE_BONUS : 1);
  const success = rng() < attack / (attack + defense);

  // 진 쪽은 내보낸 병력의 최대 20%, 이긴 쪽은 0~1명
  const loserSide = success ? defenders : committed;
  const loserLosses = randInt(rng, 1, Math.max(1, Math.round(loserSide * 0.2)));
  const winnerLosses = rng() < 0.5 ? 0 : 1;
  const attackerLosses = Math.min(a.combatants, success ? winnerLosses : loserLosses);
  const defenderLosses = Math.min(d.combatants, success ? loserLosses : winnerLosses);
  lose(a, attackerLosses);
  lose(d, defenderLosses);
  for (const f of [a, d]) f.resources[war.ammo] = Math.max(0, (f.resources[war.ammo] ?? 0) - war.ammo_per_clash);
  a.resources[war.medicine] = Math.max(0, (a.resources[war.medicine] ?? 0) - attackerLosses * war.medicine_per_casualty);
  d.resources[war.medicine] = Math.max(0, (d.resources[war.medicine] ?? 0) - defenderLosses * war.medicine_per_casualty);

  const clash: Clash = { kind, attacker: attackerId, defender: defenderId, zone, success, attackerLosses, defenderLosses, ...(plan ? { plan } : {}) };
  applySpoils(world, kind, a, d, attackerId, defenderId, zone, success, committed, clash);
  return clash;
}

/** 승패에 따른 약탈·점령·사기 */
function applySpoils(
  world: WarWorld,
  kind: Clash["kind"],
  a: FactionState,
  d: FactionState,
  attackerId: string,
  _defenderId: string,
  zone: string,
  success: boolean,
  committed: number,
  clash: Clash,
) {
  if (kind === "raid" && success) {
    const loot: Record<string, number> = {};
    for (const [r, have] of Object.entries(d.resources).sort(([x], [y]) => x.localeCompare(y))) {
      const take = Math.min(Math.floor(have * LOOT_RATE), committed * LOOT_PER_RAIDER);
      if (take <= 0) continue;
      d.resources[r] = have - take;
      a.resources[r] = (a.resources[r] ?? 0) + take;
      loot[r] = take;
    }
    clash.loot = loot;
  }
  if (kind === "assault") {
    if (success) {
      world.zones[zone] = { owner: attackerId };
      a.morale = clamp(a.morale + 1, -3, 3);
      d.morale = clamp(d.morale - 1, -3, 3);
    } else {
      a.morale = clamp(a.morale - 1, -3, 3);
    }
  }
}

/** 방침에 따른 지키는 병력 배수 (지키기면 더, 밀어붙이기면 덜) */
function defenseOf(content: Content, f: FactionState): number {
  return Math.min(DEFENSE_COMMIT_MAX / DEFENSE_COMMIT, policyEffects(content, f).defense);
}

/** 사람을 잃는다 (전투원부터) */
function lose(f: FactionState, n: number) {
  f.combatants = Math.max(0, f.combatants - n);
  f.population = Math.max(0, f.population - n);
}
