import type { Content } from "../content/schemas.ts";
import type { Clash, Party, PartyLeg, PartyTask } from "../game/state.ts";
import { MINUTES_PER_DAY, routeMinutes } from "../rules/time.ts";
import type { Rng } from "../rng.ts";
import { DEFENSE_COMMIT, disposition, fightClash, hopsFromBase, HOSTILE, neighbors, occupyZone, type ClashSpec, type WarWorld } from "./war.ts";

/**
 * 움직이는 부대 (docs/war-parties-plan.md 파트 1~3·7).
 * 하루 틱의 결정(습격·공세·땅 차지·교역·순찰)은 그 자리에서 끝나지 않고 부대를 낸다. 부대는 무리 전투원에서 빠져나가
 * 길을 걷고(남의 땅은 돌아가고, 구역마다 머물고), 목표에 닿으면 할 일을 하고 돌아와 전투원으로 돌아간다.
 * 결정적이다: 같은 RNG면 같은 부대가 같은 길을 같은 시각에 걷는다.
 */

export type PartiesConfig = NonNullable<NonNullable<Content["scenario"]["war"]>["parties"]>;
export type PartyKind = Party["kind"];

export function partiesConfig(content: Content): PartiesConfig | null {
  return content.scenario.war?.parties ?? null;
}

/** 이 부대를 부르는 이름: 무리의 이름(party_names), 없으면 시나리오의 이름 */
export function partyLabel(content: Content, party: Pick<Party, "faction" | "kind">): string {
  return content.factions[party.faction]?.party_names[party.kind] ?? partiesConfig(content)?.kinds[party.kind]?.label ?? party.kind;
}

/** 무리의 거점 (지금 그 무리 땅인 base 구역) */
export function homeBase(content: Content, world: Pick<WarWorld, "zones">, factionId: string): string | null {
  return Object.values(content.locations).find((l) => l.kind === "base" && world.zones[l.id]?.owner === factionId)?.id ?? null;
}

/** 나가 있는 부대의 인원 합 */
function outOf(world: WarWorld, factionId: string): { count: number; size: number } {
  const mine = (world.parties ?? []).filter((p) => p.faction === factionId);
  return { count: mine.length, size: mine.reduce((n, p) => n + p.size, 0) };
}

/** 동시에 낼 수 있는 부대 수 (전투원 수로, 1-1) */
export function maxParties(cfg: PartiesConfig, combatants: number): number {
  return cfg.max.find((row) => combatants >= row.combatants)?.count ?? 0;
}

/** 이만한 부대를 낼 수 있는가: 칸이 남고, 내보낸 뒤에도 지키는 병력(전투원의 DEFENSE_COMMIT)이 남는다 */
export function canSend(world: WarWorld, cfg: PartiesConfig, factionId: string, size: number): boolean {
  const f = world.factions[factionId];
  if (!f || size <= 0) return false;
  const out = outOf(world, factionId);
  const total = f.combatants + out.size;
  if (out.count >= maxParties(cfg, total)) return false;
  return f.combatants - size >= Math.ceil(total * DEFENSE_COMMIT);
}

/** 들어가는 구역의 길 찾기 비용 (3-3): 우리 땅·빈 땅 1, 적대하는 땅 3, 그 밖의 남의 땅 1.5 */
function stepCost(content: Content, world: WarWorld, factionId: string, zone: string): number {
  const owner = world.zones[zone]?.owner ?? null;
  if (owner === null || owner === factionId) return 1;
  return disposition(content, factionId, owner, world) <= HOSTILE ? 3 : 1.5;
}

/** 가장 싼 길 (출발·도착 포함). 닿지 않으면 null */
export function partyRoute(content: Content, world: WarWorld, factionId: string, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const open = new Set([from]);
  while (open.size) {
    const here = [...open].sort((a, b) => dist.get(a)! - dist.get(b)! || a.localeCompare(b))[0]!;
    open.delete(here);
    if (here === to) break;
    for (const n of neighbors(content, here)) {
      const d = dist.get(here)! + stepCost(content, world, factionId, n);
      if (d < (dist.get(n) ?? Infinity)) {
        dist.set(n, d);
        prev.set(n, here);
        open.add(n);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return path;
}

const QUARTER = 15;
const round15 = (m: number) => Math.round(m / QUARTER) * QUARTER;
/** 시간 범위(시)에서 하나 (15분 단위, 분) */
const pickHours = (rng: Rng, [a, b]: readonly [number, number]) => round15((a + rng() * Math.max(0, b - a)) * 60);

/** 이 시각 뒤로 처음 오는 치는 시각 (strike 범위 안이면 그대로) */
function nextWindow(t: number, [h0, h1]: readonly [number, number], rng: Rng): number {
  const minute = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const inWindow = h0 <= h1 ? minute >= h0 * 60 && minute < (h1 + 1) * 60 : minute >= h0 * 60 || minute < (h1 + 1) * 60;
  if (inWindow) return t;
  const dayStart = t - minute;
  const start = dayStart + h0 * 60 + (h0 * 60 <= minute ? MINUTES_PER_DAY : 0);
  const span = (((h1 - h0 + 24) % 24) + 1) * 60;
  return start + round15(rng() * (span - QUARTER));
}

/**
 * 길을 걷는 일정: 첫 칸은 출발지에서 떠나는 때까지, 나머지는 그 구역에 드는 때부터 떠나는 때까지 (칸이 이어진다).
 * 마지막 칸(목표)의 to가 닿는 시각이다. 지나는 구역마다 stay만큼 머물고(3-0), strike가 있으면 목표 바로 앞에서 그 시각까지 숨는다
 */
export function planLegs(
  content: Content,
  cfg: PartiesConfig,
  kind: PartyKind,
  route: readonly string[],
  start: number,
  depart: number,
  size: number,
  rng: Rng,
  opts: { strike?: boolean } = {},
): PartyLeg[] {
  const k = cfg.kinds[kind]!;
  const slow = size >= cfg.slow_size ? cfg.slow_factor : 1;
  const legs: PartyLeg[] = [{ zone: route[0]!, from: start, to: depart }];
  let t = depart;
  for (let i = 1; i < route.length; i++) {
    const arrive = t + round15(routeMinutes(route[i - 1]!, route[i]!, content) * slow);
    if (i === route.length - 1) {
      legs.push({ zone: route[i]!, from: t, to: arrive });
      break;
    }
    let leave = arrive + pickHours(rng, k.stay);
    if (opts.strike && k.strike && i === route.length - 2) leave = nextWindow(leave, k.strike, rng);
    legs.push({ zone: route[i]!, from: t, to: leave });
    t = leave;
  }
  return legs;
}

/** 부대가 이 시각에 있는 구역 (나가기 전이거나 돌아온 뒤면 null) */
export function partyZoneAt(party: Party, t: number): string | null {
  for (const leg of [...party.legs, ...party.back]) if (t >= leg.from && t <= leg.to) return leg.zone;
  return null;
}

/** 목표에 닿는 시각 */
export const arrivalOf = (party: Party) => party.legs[party.legs.length - 1]!.to;
/** 거점에 돌아오는 시각 (아직 돌아오는 길을 정하지 않았으면 null) */
export const returnOf = (party: Party) => (party.back.length ? party.back[party.back.length - 1]!.to : null);

export type SpawnArgs = { faction: string; kind: PartyKind; goal: string; task: PartyTask; size: number; dayStart: number; carry?: Record<string, number> };

/** 부대를 낸다. 낼 수 없으면(거점·길·칸·지키는 병력) null */
export function spawnParty(world: WarWorld, content: Content, rng: Rng, args: SpawnArgs): Party | null {
  const cfg = partiesConfig(content);
  const k = cfg?.kinds[args.kind];
  if (!cfg || !k) return null;
  const home = homeBase(content, world, args.faction);
  if (!home || home === args.goal) return null;
  const route = partyRoute(content, world, args.faction, home, args.goal);
  if (!route || route.length < 2) return null;
  if (!canSend(world, cfg, args.faction, args.size)) return null;
  const start = args.dayStart + pickHours(rng, k.depart);
  const depart = start + k.gather_hours * 60;
  const legs = planLegs(content, cfg, args.kind, route, start, depart, args.size, rng, { strike: args.task.kind === "clash" });
  const f = world.factions[args.faction]!;
  f.combatants -= args.size;
  for (const [r, n] of Object.entries(args.carry ?? {})) f.resources[r] = Math.max(0, (f.resources[r] ?? 0) - n);
  const party: Party = {
    id: `party_${world.nextPartyNo ?? 0}`,
    faction: args.faction,
    kind: args.kind,
    size: args.size,
    leader: null,
    home,
    goal: args.goal,
    legs,
    task: args.task,
    done: false,
    back: [],
    carry: { ...(args.carry ?? {}) },
  };
  world.nextPartyNo = (world.nextPartyNo ?? 0) + 1;
  world.parties = [...(world.parties ?? []), party];
  return party;
}

export type AdvanceOptions = {
  /** true면 이 교전을 계산하지 않고 미룬다 (플레이어가 낄 때). 미룬 부대는 흩어져 전투원으로 돌아가고, 교전은 예정된 교전이 된다 */
  defer?: (spec: ClashSpec, at: number) => boolean;
};

export type AdvanceResult = { clashes: Clash[]; deferred: (ClashSpec & { at: number })[] };

/** 이 시각까지 닿은 부대의 할 일을 하고, 돌아온 부대를 거둔다 (시각 순서대로). world를 고친다 */
export function advanceParties(world: WarWorld, content: Content, rng: Rng, upTo: number, opts: AdvanceOptions = {}): AdvanceResult {
  const cfg = partiesConfig(content);
  const out: AdvanceResult = { clashes: [], deferred: [] };
  if (!cfg) return out;
  const due = (p: Party) => (p.done ? (returnOf(p) ?? arrivalOf(p)) : arrivalOf(p));
  for (;;) {
    const next = (world.parties ?? []).filter((p) => due(p) <= upTo).sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id))[0];
    if (!next) return out;
    if (next.done) endParty(world, next);
    else arrive(world, content, rng, cfg, next, out, opts);
  }
}

function removeParty(world: WarWorld, id: string) {
  world.parties = (world.parties ?? []).filter((p) => p.id !== id);
}

/** 돌아왔다: 남은 사람은 전투원으로, 나르던 것은 창고로 */
function endParty(world: WarWorld, party: Party) {
  const f = world.factions[party.faction];
  if (f) {
    f.combatants += party.size;
    for (const [r, n] of Object.entries(party.carry)) f.resources[r] = (f.resources[r] ?? 0) + n;
  }
  removeParty(world, party.id);
}

function arrive(world: WarWorld, content: Content, rng: Rng, cfg: PartiesConfig, party: Party, out: AdvanceResult, opts: AdvanceOptions) {
  const at = arrivalOf(party);
  const f = world.factions[party.faction];
  if (!f) return removeParty(world, party.id);
  const task = party.task;
  let stay = 0;
  if (task.kind === "clash") {
    const spec: ClashSpec = { kind: task.clash, attacker: party.faction, defender: task.defender, zone: party.goal, ...(task.plan ? { plan: task.plan } : {}) };
    const defender = world.factions[task.defender];
    if (world.zones[party.goal]?.owner === task.defender && defender && defender.population > 0) {
      if (opts.defer?.(spec, at)) {
        // 플레이어가 낄 교전: 부대는 흩어져 전투원으로 돌아가고, 교전은 그 시각의 예정된 교전이 된다 (전투 장면, 기획서 9.5)
        out.deferred.push({ ...spec, at });
        f.combatants += party.size;
        return removeParty(world, party.id);
      }
      // 먼 길의 대가 (7-1): 거점에서 먼 곳을 치면 사기가 한 단계 낮은 채로 싸운다
      const far = hopsFromBase(content, world, party.faction, party.goal) > cfg.far_hops;
      f.combatants += party.size;
      if (far) f.morale -= 1;
      const clash = fightClash(world, content, rng, spec, party.size);
      if (far) f.morale = Math.min(3, f.morale + 1);
      const survivors = Math.max(0, Math.min(f.combatants, party.size - clash.attackerLosses));
      f.combatants -= survivors;
      party.size = survivors;
      out.clashes.push(clash);
    }
  } else if (task.kind === "occupy") {
    if ((world.zones[party.goal]?.owner ?? null) === null) out.clashes.push(occupyZone(world, party.faction, party.goal, task.plan));
    stay = pickHours(rng, cfg.kinds[party.kind]!.stay);
  } else if (task.kind === "trade") {
    const partner = world.factions[task.partner];
    const has = (need: Record<string, number>) => Object.entries(need).every(([r, n]) => (partner?.resources[r] ?? 0) >= n);
    if (partner && partner.population > 0 && has(task.get)) {
      for (const [r, n] of Object.entries(party.carry)) partner.resources[r] = (partner.resources[r] ?? 0) + n;
      for (const [r, n] of Object.entries(task.get)) partner.resources[r] = (partner.resources[r] ?? 0) - n;
      party.carry = { ...task.get };
    }
    stay = pickHours(rng, cfg.kinds[party.kind]!.stay);
  } else {
    stay = pickHours(rng, cfg.kinds[party.kind]!.stay);
  }
  // 모두 쓰러졌으면 나르던 것도 잃는다
  if (party.size <= 0) return removeParty(world, party.id);
  party.done = true;
  const route = partyRoute(content, world, party.faction, party.goal, party.home);
  party.back = route && route.length >= 2 ? planLegs(content, cfg, party.kind, route, at, at + stay, party.size, rng) : [];
}

/** 자기 땅 가장자리 (거점이 아니고, 남의 땅·빈 땅과 맞닿은 우리 땅) */
export function borderZones(content: Content, world: WarWorld, factionId: string): string[] {
  return Object.keys(world.zones)
    .filter((z) => world.zones[z]!.owner === factionId && content.locations[z]?.kind !== "base")
    .filter((z) => neighbors(content, z).some((n) => world.zones[n]?.owner !== factionId))
    .sort();
}
