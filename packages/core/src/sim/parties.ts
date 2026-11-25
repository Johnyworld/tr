import type { Content } from "../content/schemas.ts";
import type { Clash, Party, PartyLeg, PartyTask } from "../game/state.ts";
import { MINUTES_PER_DAY, routeMinutes } from "../rules/time.ts";
import type { Rng } from "../rng.ts";
import { AMBUSH_FACTOR, canAmbush, isNight, partyChoice, partyNoticeBonus, sightings } from "../rules/encounter.ts";
import { DEFENSE_COMMIT, disposition, fightClash, frontierTarget, hopsFromBase, HOSTILE, neighbors, occupyZone, type ClashSpec, type WarWorld } from "./war.ts";

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

/** 싸우러 나가는 부대 (칸을 센다). 정찰·순찰·짐 행렬은 칸을 세지 않는다 (PT31: 칸을 차지해 습격이 못 나갔다) */
const FIGHTING: readonly string[] = ["raid", "assault"];

/** 이만한 부대를 낼 수 있는가: (싸우러 나가는 부대면) 칸이 남고, 내보낸 뒤에도 지키는 병력(전투원의 DEFENSE_COMMIT)이 남는다 */
export function canSend(world: WarWorld, cfg: PartiesConfig, factionId: string, size: number, kind: string = "raid"): boolean {
  const f = world.factions[factionId];
  if (!f || size <= 0) return false;
  const out = outOf(world, factionId);
  const total = f.combatants + out.size;
  const fighting = (world.parties ?? []).filter((p) => p.faction === factionId && FIGHTING.includes(p.kind)).length;
  if (FIGHTING.includes(kind) && fighting >= maxParties(cfg, total)) return false;
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
  // 칸 경계(앞 칸의 to = 뒤 칸의 from)에서는 뒤 칸: 막 들어선 구역에 있다 (PT32 네 판: 빨리감기가 멈춘 그 분에 앞 구역으로 셌다)
  let zone: string | null = null;
  for (const leg of [...party.legs, ...party.back]) if (t >= leg.from && t <= leg.to) zone = leg.zone;
  return zone;
}

/** 부대가 이 구역에 머무는 이번 방문이 시작된 시각 (같은 구역 칸이 이어지면 하나로). 머물지 않으면 null */
export function visitStart(party: Party, zone: string, t: number): number | null {
  const legs = [...party.legs, ...party.back];
  let i = -1;
  legs.forEach((l, k) => {
    if (l.zone === zone && t >= l.from && t <= l.to) i = k;
  });
  if (i < 0) return null;
  while (i > 0 && legs[i - 1]!.zone === zone) i--;
  return legs[i]!.from;
}

/** 목표에 닿는 시각 */
export const arrivalOf = (party: Party) => party.legs[party.legs.length - 1]!.to;
/** 거점에 돌아오는 시각 (아직 돌아오는 길을 정하지 않았으면 null) */
export const returnOf = (party: Party) => (party.back.length ? party.back[party.back.length - 1]!.to : null);

export type SpawnArgs = { faction: string; kind: PartyKind; goal: string; task: PartyTask; size: number; dayStart: number; carry?: Record<string, number>; leaderOk?: (npcId: string) => boolean };

/** 습격·공세를 이끌 이름 있는 인물 (1-3): 그 무리의 leader_ranks 계급, 이미 다른 부대를 이끄는 사람은 빼고. leaderOk로 더 거른다(게임: 세계가 건드리지 않는 사람) */
function pickLeader(world: WarWorld, content: Content, rng: Rng, factionId: string, ok?: (npcId: string) => boolean): string | null {
  const ranks = partiesConfig(content)?.leader_ranks ?? [];
  if (!ranks.length) return null;
  const busy = new Set((world.parties ?? []).map((p) => p.leader).filter(Boolean));
  const pool = Object.values(content.npcs)
    .filter((n) => n.faction === factionId && ranks.includes(n.rank) && !busy.has(n.id) && (!ok || ok(n.id)))
    .map((n) => n.id)
    .sort();
  return pool.length ? pool[Math.floor(rng() * pool.length)]! : null;
}

/** 부대를 낸다. 낼 수 없으면(거점·길·칸·지키는 병력) null */
export function spawnParty(world: WarWorld, content: Content, rng: Rng, args: SpawnArgs): Party | null {
  const cfg = partiesConfig(content);
  const k = cfg?.kinds[args.kind];
  if (!cfg || !k) return null;
  const home = homeBase(content, world, args.faction);
  if (!home || home === args.goal) return null;
  const route = partyRoute(content, world, args.faction, home, args.goal);
  if (!route || route.length < 2) return null;
  if (!canSend(world, cfg, args.faction, args.size, args.kind)) return null;
  const start = args.dayStart + pickHours(rng, k.depart);
  const depart = start + k.gather_hours * 60;
  const legs = planLegs(content, cfg, args.kind, route, start, depart, args.size, rng, { strike: args.task.kind === "clash" });
  const f = world.factions[args.faction]!;
  f.combatants -= args.size;
  const leader = args.kind === "raid" || args.kind === "assault" ? pickLeader(world, content, rng, args.faction, args.leaderOk) : null;
  for (const [r, n] of Object.entries(args.carry ?? {})) f.resources[r] = Math.max(0, (f.resources[r] ?? 0) - n);
  const party: Party = {
    id: `party_${world.nextPartyNo ?? 0}`,
    faction: args.faction,
    kind: args.kind,
    size: args.size,
    leader,
    home,
    goal: args.goal,
    legs,
    task: args.task,
    done: false,
    back: [],
    carry: { ...(args.carry ?? {}) },
    met: [],
    routedAt: null,
  };
  world.nextPartyNo = (world.nextPartyNo ?? 0) + 1;
  world.parties = [...(world.parties ?? []), party];
  return party;
}

export type AdvanceOptions = {
  /** true면 이 교전을 계산하지 않고 미룬다 (플레이어가 낄 때). 교전은 예정된 교전이 되고, 부대는 닿은 자리에서 흩어진다 */
  defer?: (spec: ClashSpec, at: number) => boolean;
  /** 돌아온 부대를 이 시각까지만 거둔다 (게임: 지금. 그 뒤로는 아직 길 위에 있다). 없으면 upTo */
  endUpTo?: number;
};

export type AdvanceResult = { clashes: Clash[]; deferred: (ClashSpec & { at: number })[] };

/** 이 부대가 이 시각에 그 구역에서 숨어 기다리는 중인가 (습격대가 목표 바로 앞에서) */
export function hidingAt(party: Party, t: number): boolean {
  if (party.done || party.task.kind !== "clash" || party.legs.length < 3) return false;
  const leg = party.legs[party.legs.length - 2]!;
  return t >= leg.from && t <= leg.to;
}

const hostile = (content: Content, world: WarWorld, a: string, b: string) =>
  a !== b && (disposition(content, a, b, world) <= HOSTILE || disposition(content, b, a, world) <= HOSTILE);

/** 아직 마주치지 않은 적대 부대 짝 가운데 가장 이른 마주침 (같은 구역에 함께 있는 첫 시각) */
function nextEncounter(content: Content, world: WarWorld, from: number, upTo: number): { a: Party; b: Party; zone: string; at: number } | null {
  const parties = world.parties ?? [];
  let best: { a: Party; b: Party; zone: string; at: number } | null = null;
  for (let i = 0; i < parties.length; i++) {
    for (let j = i + 1; j < parties.length; j++) {
      const a = parties[i]!;
      const b = parties[j]!;
      if (a.size <= 0 || b.size <= 0 || a.met.includes(b.id) || !hostile(content, world, a.faction, b.faction)) continue;
      for (const la of [...a.legs, ...a.back]) {
        for (const lb of [...b.legs, ...b.back]) {
          if (la.zone !== lb.zone) continue;
          const s = Math.max(la.from, lb.from, from);
          const e = Math.min(la.to, lb.to);
          if (s > e || s > upTo) continue;
          if (!best || s < best.at) best = { a, b, zone: la.zone, at: s };
        }
      }
    }
  }
  return best;
}

/** 이 시각까지 닿은 부대의 할 일을 하고, 부대끼리의 마주침을 풀고, 돌아온 부대를 거둔다 (시각 순서대로). world를 고친다 */
export function advanceParties(world: WarWorld, content: Content, rng: Rng, upTo: number, opts: AdvanceOptions = {}): AdvanceResult {
  const cfg = partiesConfig(content);
  const out: AdvanceResult = { clashes: [], deferred: [] };
  if (!cfg) return out;
  const endUpTo = Math.min(upTo, opts.endUpTo ?? upTo);
  const due = (p: Party) => (p.done ? (returnOf(p) ?? arrivalOf(p)) : arrivalOf(p));
  const limit = (p: Party) => (p.done ? endUpTo : upTo);
  let cursor = world.partiesUpTo ?? 0;
  for (;;) {
    const ms = (world.parties ?? []).filter((p) => due(p) <= limit(p)).sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id))[0];
    const enc = nextEncounter(content, world, cursor, Math.min(upTo, ms ? due(ms) : upTo));
    if (enc && (!ms || enc.at <= due(ms))) {
      cursor = enc.at;
      meet(world, content, rng, cfg, enc, out);
      continue;
    }
    if (!ms) break;
    cursor = Math.max(cursor, due(ms));
    if (ms.done) endParty(world, content, ms);
    else arrive(world, content, rng, cfg, ms, out, opts);
  }
  world.partiesUpTo = Math.max(world.partiesUpTo ?? 0, upTo);
  return out;
}

function removeParty(world: WarWorld, id: string) {
  world.parties = (world.parties ?? []).filter((p) => p.id !== id);
}

/** 돌아왔다: 남은 사람은 전투원으로, 나르던 것은 창고로 */
function endParty(world: WarWorld, content: Content, party: Party) {
  // 공세를 앞두고 나간 정찰대가 목표의 방비(보강한 담)를 보고 돌아오면, 맞닿은 다른 적 구역으로 목표를 바꾼다 (6-4, frontier 클락만)
  const scoutPlan = party.kind === "scout" && party.task.kind === "watch" ? party.task.plan : undefined;
  if (scoutPlan && party.size > 0) {
    const clock = world.clocks[scoutPlan];
    const plan = content.factions[party.faction]?.plans.find((p) => p.id === scoutPlan);
    if (clock && plan?.target_rule === "frontier" && (world.zones[party.goal]?.fort ?? 0) > 0) {
      const other = frontierTarget(world, content, party.faction, party.goal);
      if (other) clock.target = other;
    }
  }
  const f = world.factions[party.faction];
  if (f) {
    f.combatants += party.size;
    for (const [r, n] of Object.entries(party.carry)) f.resources[r] = (f.resources[r] ?? 0) + n;
  }
  removeParty(world, party.id);
}

/** 정찰로 적 배치를 알고 치는 기습의 화력 배수 (파트 11, *임시*) */
export const SURPRISE_FACTOR = 1.3;

/** 기세 (6-3): 사흘 안에 두 번 진 무리는 사기 -1. 연승 보너스는 없다 */
export const STREAK_DAYS = 3;
export function recordDefeat(world: WarWorld, factionId: string | null | undefined, at: number): void {
  const f = factionId ? world.factions[factionId] : undefined;
  if (!f) return;
  const recent = [...(f.defeats ?? []).filter((t) => t > at - STREAK_DAYS * MINUTES_PER_DAY), at];
  if (recent.length >= 2) {
    f.morale = Math.max(-3, f.morale - 1);
    delete f.defeats;
  } else f.defeats = recent;
}

/** 부대를 이 자리에서 돌려보낸다 (주인공에게 꺾였다, 우두머리를 잃었다 등). 다 쓰러졌으면 그 자리에서 끝난다 */
export function routParty(world: WarWorld, content: Content, rng: Rng, partyId: string, at: number): void {
  const cfg = partiesConfig(content);
  const party = (world.parties ?? []).find((p) => p.id === partyId);
  if (!cfg || !party) return;
  const zone = partyZoneAt(party, at) ?? party.goal;
  party.routedAt = at;
  party.carry = Object.fromEntries(Object.entries(party.carry).map(([r, n]) => [r, Math.floor(n / 2)]));
  if (party.size <= 0) {
    party.done = true;
    party.back = [];
    return;
  }
  turnBack(world, content, rng, cfg, party, zone, at);
}

/** 길을 접고 지금 자리에서 거점으로 돌아간다 */
function turnBack(world: WarWorld, content: Content, rng: Rng, cfg: PartiesConfig, party: Party, zone: string, at: number) {
  const before = (legs: PartyLeg[]) => legs.filter((l) => l.from <= at).map((l) => (l.to > at ? { ...l, to: at } : l));
  const walked = party.done ? before(party.back) : [];
  if (!party.done) party.legs = before(party.legs);
  if (!party.legs.length) party.legs = [{ zone, from: at, to: at }];
  party.done = true;
  const route = partyRoute(content, world, party.faction, zone, party.home);
  // 거점에 이미 닿았으면(돌아오는 길의 끝) 그 자리에서 끝난다
  party.back = [...walked, ...(route && route.length >= 2 ? planLegs(content, cfg, party.kind, route, at, at, party.size, rng).slice(1) : [{ zone, from: at, to: at }])];
}

/**
 * 부대끼리 마주쳤다 (공통 규칙 23, 4-1~4-4). 서로 알아채고, 알아챈 쪽이 고르고, 싸우면 진 쪽이 달아난다.
 * 같은 날 두 번 지면 남은 사람이 붙잡힌다. 본 쪽 무리는 하루 동안 그 무리의 빈틈을 안다 (7-2)
 */
function meet(world: WarWorld, content: Content, rng: Rng, cfg: PartiesConfig, enc: { a: Party; b: Party; zone: string; at: number }, out: AdvanceResult) {
  const { a, b, zone, at } = enc;
  a.met.push(b.id);
  b.met.push(a.id);
  const cover = content.locations[zone]?.cover ?? 0;
  const night = isNight(at);
  const seen = sightings(rng, { bonus: partyNoticeBonus(a.kind), hidden: { hiding: hidingAt(a, at), night, cover } }, { bonus: partyNoticeBonus(b.kind), hidden: { hiding: hidingAt(b, at), night, cover } });
  const knows = (who: Party, other: Party) => {
    const f = world.factions[who.faction];
    if (f) f.seen = { ...(f.seen ?? {}), [other.faction]: at + MINUTES_PER_DAY };
  };
  if (seen.aSees) knows(a, b);
  if (seen.bSees) knows(b, a);
  const own = (p: Party) => world.zones[zone]?.owner === p.faction;
  const wants = (p: Party, other: Party, sees: boolean) => sees && partyChoice({ kind: p.kind, size: p.size, onOwnLand: own(p) }, { size: other.size }) === "fight";
  const aFights = wants(a, b, seen.aSees);
  const bFights = wants(b, a, seen.bSees);
  if (!aFights && !bFights) return;
  // 먼저 본 쪽이 혼자 덤비면 자기 땅에서는 매복이다 (4-3)
  const [attacker, defender] = aFights ? [a, b] : [b, a];
  const ambush = (attacker === a ? !seen.bSees : !seen.aSees) && canAmbush(own(attacker));
  const fa = world.factions[attacker.faction]!;
  const fd = world.factions[defender.faction]!;
  const power = (p: Party, f: typeof fa, bonus: number) => p.size * (1 + 0.1 * f.morale) * bonus;
  const pa = power(attacker, fa, ambush ? AMBUSH_FACTOR : 1);
  const pd = power(defender, fd, 1);
  const success = rng() < pa / (pa + pd);
  const [winner, loser] = success ? [attacker, defender] : [defender, attacker];
  const loserLosses = Math.min(loser.size, 1 + Math.floor(rng() * Math.max(1, Math.round(loser.size * 0.2))));
  const winnerLosses = Math.min(winner.size, rng() < 0.5 ? 0 : 1);
  const take = (p: Party, n: number) => {
    p.size -= n;
    const f = world.factions[p.faction];
    if (f) f.population = Math.max(0, f.population - n);
  };
  take(loser, loserLosses);
  take(winner, winnerLosses);
  out.clashes.push({
    kind: "skirmish",
    attacker: attacker.faction,
    defender: defender.faction,
    zone,
    success,
    attackerLosses: attacker === winner ? winnerLosses : loserLosses,
    defenderLosses: defender === winner ? winnerLosses : loserLosses,
  });
  recordDefeat(world, loser.faction, at);
  // 진 쪽은 달아난다: 짐 절반을 버리고 거점으로. 같은 날 두 번째로 지면 남은 사람이 붙잡힌다 (4-4)
  const twice = loser.routedAt !== null && Math.floor(loser.routedAt / MINUTES_PER_DAY) === Math.floor(at / MINUTES_PER_DAY);
  if (twice) {
    const f = world.factions[loser.faction];
    if (f) f.population = Math.max(0, f.population - loser.size);
    loser.size = 0;
  }
  loser.routedAt = at;
  loser.carry = Object.fromEntries(Object.entries(loser.carry).map(([r, n]) => [r, Math.floor(n / 2)]));
  // 공세를 앞두고 나간 정찰대가 쫓겨나면 공세가 하루 늦어진다 (2-1)
  if (loser.task.kind === "watch" && loser.task.plan && !loser.done) {
    const clock = world.clocks[loser.task.plan];
    if (clock) clock.filled = Math.max(0, clock.filled - 1);
  }
  if (loser.size <= 0) {
    loser.done = true;
    loser.back = [];
    loser.legs = loser.legs.filter((l) => l.from <= at).map((l) => (l.to > at ? { ...l, to: at } : l));
    if (!loser.legs.length) loser.legs = [{ zone, from: at, to: at }];
    return;
  }
  turnBack(world, content, rng, cfg, loser, zone, at);
}

function arrive(world: WarWorld, content: Content, rng: Rng, cfg: PartiesConfig, party: Party, out: AdvanceResult, opts: AdvanceOptions) {
  const at = arrivalOf(party);
  const f = world.factions[party.faction];
  if (!f) return removeParty(world, party.id);
  if (party.size <= 0) return removeParty(world, party.id);
  const task = party.task;
  let stay = 0;
  if (task.kind === "clash") {
    const spec: ClashSpec = { kind: task.clash, attacker: party.faction, defender: task.defender, zone: party.goal, ...(task.plan ? { plan: task.plan } : {}) };
    const defender = world.factions[task.defender];
    if (world.zones[party.goal]?.owner === task.defender && defender && defender.population > 0) {
      if (opts.defer?.(spec, at)) {
        // 플레이어가 낄 교전: 그 시각의 예정된 교전이 된다 (전투 장면, 기획서 9.5). 부대는 닿은 자리에서 흩어져, 다음에 거둘 때 전투원으로 돌아간다
        out.deferred.push({ ...spec, at });
        party.done = true;
        party.back = [];
        return;
      }
      // 먼 길의 대가 (7-1): 거점에서 먼 곳을 치면 사기가 한 단계 낮은 채로 싸운다
      const far = hopsFromBase(content, world, party.faction, party.goal) > cfg.far_hops;
      f.combatants += party.size;
      if (far) f.morale -= 1;
      // 정찰로 적 배치를 알고 치면 기습이다 (파트 11, *임시* 화력 ×1.3)
      const clash = fightClash(world, content, rng, spec, task.surprise ? Math.round(party.size * SURPRISE_FACTOR) : party.size);
      if (task.credits?.length) clash.credits = task.credits;
      if (far) f.morale = Math.min(3, f.morale + 1);
      recordDefeat(world, clash.success ? task.defender : party.faction, at);
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
  party.done = true;
  // 모두 쓰러졌으면 나르던 것도 잃는다 (그 자리에서 끝난다)
  if (party.size <= 0) {
    party.back = [];
    party.carry = {};
    return;
  }
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
