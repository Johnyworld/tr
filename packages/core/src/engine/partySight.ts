import { startPartyFight } from "./partyTools.ts";
import { darknessOf } from "../rules/darkness.ts";
import { traitSight } from "./traits.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState, Party } from "../game/state.ts";
import { canAmbush, isNight, partyChoice, partyNoticeBonus, personNoticeBonus, sightings, type Concealment } from "../rules/encounter.ts";
import { hostileFaction, ownedBy } from "../rules/home.ts";
import { companyHere } from "../rules/company.ts";
import { currentPlace, directionTo, guardedHere, kindsOf, neighborsOf, placesIn, roadsIn, stepsBetween } from "../rules/place.ts";
import { formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import type { Rng } from "../rng.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import { arrivalOf, hidingAt, partyLabel, partyZoneAt, visitStart } from "../sim/parties.ts";
import { josa } from "../text.ts";
import { forceWords, playerInvolvement } from "./battleTools.ts";
import { campWatched } from "./camp.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 주인공과 부대의 마주침 (공통 규칙 23, docs/war-parties-plan.md 파트 9).
 * 부대가 주인공이 있는 구역에 들면 한 번 서로 알아채기를 굴린다 (부대·구역마다 한 번, partySightings).
 * - 바깥 장소나 망루에서만 본다. 지붕 아래에서는 서로 보지 못한다 (부대는 그 구역의 바깥 장소를 지난다)
 * - 지켜 주는 곳(우리 거점·피난처·재워 주는 거점)에서는 굴리지 않는다
 * - 잠들었으면 주인공은 굴리지 않고, 불침번이 있으면 그 사람이 대신 본다
 * - 적대하는 부대를 주인공이 보거나, 부대만 보고 덤비면 빨리감기가 멈춘다 (매복당한 채로)
 */

export const PARTY_INTERRUPT = "party";

/**
 * 마주침 기록의 열쇠: 부대·구역·그 방문 (PT32 분대장: 한 번 본 부대가 그 구역에서 계속 본 것으로 남아, 다시 들어서자 지금 자리가 새었다).
 * 주인공이 그 구역을 떠나면 그 구역의 기록은 지운다 (zone_moved)
 */
export function sightKey(party: Party, zone: string, t: number): string {
  return `${party.id}@${zone}@${visitStart(party, zone, t) ?? t}`;
}

/** 주인공 쪽 사람 수 (주인공 + 곁의 동행) */
function groupSize(state: GameState, content: Content): number {
  return 1 + companyHere(state, content).length + alliedPartiesHere(state).reduce((n, p) => n + p.size, 0);
}

/** 지금 주인공 구역에 있는 우리 무리 부대 (맞닥뜨리면 함께 맞선다, PT37 사용자 결정) */
export function alliedPartiesHere(state: GameState, at: number = state.time): Party[] {
  const mine = state.characters[state.playerId]?.factionId;
  const zone = state.playerZone;
  if (!mine || !zone) return [];
  return state.parties.filter((p) => p.faction === mine && p.size > 0 && partyZoneAt(p, at) === zone);
}

/** 지금 자리에서 바깥이 보이는가: 바깥 장소이거나 망루. 장소가 없는 구역이면 본다 */
function outdoorsHere(state: GameState, content: Content): boolean {
  const place = currentPlace(state, content);
  return !place || !place.indoor || kindsOf(place).includes("watch");
}

/** 부대가 이 구역에서 머무는 칸과 그 앞뒤 구역 */
function legAround(party: Party, zone: string, t: number) {
  const legs = [...party.legs, ...party.back];
  let i = -1;
  legs.forEach((l, k) => {
    if (l.zone === zone && t >= l.from && t <= l.to) i = k;
  });
  if (i < 0) i = legs.findIndex((l) => l.zone === zone && l.to >= t);
  if (i < 0) return null;
  // 같은 구역 칸이 이어지면(목표에서 머문 뒤 돌아오는 길의 첫 칸) 그 앞뒤의 다른 구역 (PT32 떠돌이: 앞 구역이 같은 구역이 되어 자리가 임의의 길로 잡혔다)
  let a = i;
  while (a > 0 && legs[a - 1]!.zone === zone) a--;
  let b = i;
  while (b < legs.length - 1 && legs[b + 1]!.zone === zone) b++;
  return { prev: a > 0 ? legs[a - 1]!.zone : null, next: b < legs.length - 1 ? legs[b + 1]!.zone : null };
}

/**
 * 부대의 장소 길 (docs/war-parties-plan.md 파트 12, 계산으로만): 떠나온 구역 쪽 길로 들어와 가장 짧은 바깥 장소 길로 다음 구역 쪽 길로 나간다.
 * 담 안(실내·담 문·가두는 곳)은 지나지 않는다. 이 구역에서 머무는 부대(목표)는 망루·거리·마당 하나에 머문다
 */
export function partyPlacePath(state: GameState, content: Content, party: Party, zone: string, t: number = state.time): { enter: string | null; places: string[] } {
  const around = legAround(party, zone, t);
  const roads = roadsIn(state, content, zone);
  if (!around || !roads.length) return { enter: null, places: [] };
  const open = new Set(placesIn(state, content, zone).filter((p) => p.road || (!p.indoor && !p.jail && !kindsOf(p).includes("gate"))).map((p) => p.id));
  const enter = (around.prev && roads.find((r) => r.to.includes(around.prev!))) || roads[0]!;
  const exit = around.next ? roads.find((r) => r.to.includes(around.next!)) : undefined;
  const stay = exit
    ? null
    : placesIn(state, content, zone)
        .filter((p) => open.has(p.id) && !p.road && kindsOf(p).some((k) => k === "watch" || k === "street" || k === "yard"))
        .map((p) => p.id)
        .sort()[0];
  const goal = exit?.id ?? stay ?? enter.id;
  // 바깥 장소만 따라 가장 짧은 길
  const prev = new Map<string, string>();
  const seen = new Set([enter.id]);
  const queue = [enter.id];
  while (queue.length) {
    const here = queue.shift()!;
    if (here === goal) break;
    for (const n of neighborsOf(state, content, here, zone)) {
      if (!open.has(n) || seen.has(n)) continue;
      seen.add(n);
      prev.set(n, here);
      queue.push(n);
    }
  }
  const path = [goal];
  while (path[0] !== enter.id && prev.has(path[0]!)) path.unshift(prev.get(path[0]!)!);
  if (path[0] !== enter.id) path.unshift(enter.id);
  return { enter: enter.id, places: path };
}

/**
 * 알아채기 거리 (파트 12): 부대의 장소 길에서 주인공 자리와 가장 가까운 칸 수. 같은 장소 +2, 한 칸 옆 0, 망루에서는 두 칸까지 0, 더 멀면 굴리지 않는다(null).
 * 주인공의 보는 칸(트레잇 sight): 매의 눈(+1)은 한 칸 더 멀리까지 보고 그 칸은 -1 (부대는 거기서 주인공을 보지 못한다),
 * 둔한 감각(-1)은 같은 장소가 아니면 -1.
 * 장소가 없는 구역(다른 월드 팩)이면 0
 */
function distanceBonus(state: GameState, content: Content, party: Party, zone: string, t: number, sight = 0): { mine: number; theirs: number } | null {
  const here = currentPlace(state, content);
  if (!here) return { mine: 0, theirs: 0 };
  const { places } = partyPlacePath(state, content, party, zone, t);
  if (!places.length) return { mine: 0, theirs: 0 };
  const d = Math.min(...places.map((p) => stepsBetween(state, content, here.id, p, zone)));
  const watch = kindsOf(here).includes("watch");
  // 저쪽에서 망루 위는 잘 보이지 않는다
  const theirs = watch ? -2 : 0;
  if (d === 0) return { mine: 2, theirs: theirs + 2 };
  const base = watch ? 2 : 1;
  if (d <= base) return { mine: Math.min(0, sight), theirs };
  // 더 멀리 보는 눈: 저쪽은 이 거리에서 주인공을 보지 못한다
  if (d <= base + Math.max(0, sight)) return { mine: -1, theirs: -99 };
  return null;
}

/** rolled: 실제로 굴렸는가 (실내이거나 멀어서 굴리지 않았으면 false: 기록하지 않고 나중에 다시 굴린다, PT31) */
export type SightRoll = { player: boolean; party: boolean; attacks: boolean; rolled?: boolean };

/** 한 번 서로 알아채기를 굴린다 (공통 규칙 23). asleep이면 불침번이 있을 때만 주인공 쪽이 본다 */
export function rollPartySight(state: GameState, content: Content, rng: Rng, party: Party, at: number, opts: { asleep?: boolean; watched?: boolean; guarding?: boolean } = {}): SightRoll {
  const zone = state.playerZone!;
  if (!outdoorsHere(state, content)) return { player: false, party: false, attacks: false, rolled: false };
  // 장소 사이는 멀다: 같은 장소·한 칸 옆(망루면 두 칸)만 서로 볼 수 있다 (파트 12)
  const me0 = state.characters[state.playerId];
  const dist = distanceBonus(state, content, party, zone, at, opts.asleep || !me0 ? 0 : traitSight(content, me0));
  if (!dist) return { player: false, party: false, attacks: false, rolled: false };
  const me = state.characters[state.playerId]!;
  const cover = content.locations[zone]?.cover ?? 0;
  const night = isNight(at);
  const partyHidden: Concealment = { hiding: hidingAt(party, at), night, cover };
  // 어둠 속 눈 (공통 규칙 27): 불빛이 없으면 잘 못 보고, 불빛을 켰으면 밤의 가림을 못 받는다
  const dark = darknessOf(state, content, at);
  const meHidden: Concealment = { hiding: !!state.ambush, night: night && !dark.glare, cover };
  // 잠든 사람은 보지 못한다. 불침번은 그 사람의 눈으로 본다 (보정 없음)
  const myBonus = opts.asleep ? (opts.watched ? 0 : null) : personNoticeBonus(content, me);
  const seen = sightings(rng, { bonus: (myBonus ?? -99) - dark.penalty + dist.mine, hidden: meHidden }, { bonus: partyNoticeBonus(party.kind) + dist.theirs, hidden: partyHidden });
  // 보초를 서는 사람은 보이는 거리에 든 무리를 놓치지 않는다 (PT35 졸병·PT34 분대장: 보초 중 공세 부대가 들어서도 끝날 때야 알았다)
  const player = myBonus !== null && (seen.aSees || !!opts.guarding);
  const partySaw = seen.bSees;
  // 주인공을 본 부대가 덤비는가: 적대하는 무리이고, 주인공 쪽보다 넉넉히 많을 때 (4-2)
  const onOwnLand = ownedBy(state, zone, party.faction);
  const attacks = partySaw && hostileFaction(state, content, party.faction) && partyChoice({ kind: party.kind, size: party.size, onOwnLand, returning: party.done }, { size: groupSize(state, content) }) === "fight";
  return { player, party: partySaw, attacks, rolled: true };
}

/** 이 구간에 주인공 구역에 드는 부대 (아직 굴리지 않은 것). 처음 드는 시각과 함께 */
function arrivingParties(state: GameState, from: number, to: number): { party: Party; at: number }[] {
  const zone = state.playerZone;
  if (!zone) return [];
  const out: { party: Party; at: number }[] = [];
  for (const party of [...state.parties].sort((a, b) => a.id.localeCompare(b.id))) {
    const leg = [...party.legs, ...party.back].find((l) => l.zone === zone && l.to > from && l.from <= to);
    if (!leg || party.size <= 0) continue;
    const at = Math.max(leg.from, from + 1);
    if (state.partySightings[sightKey(party, zone, at)]) continue;
    out.push({ party, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 빨리감기의 끼어들기 검사: 적대하는 부대를 보거나 부대가 덤비면 그 시각에 멈춘다 (9-1·9-2) */
export function createPartyCheck(content: Content, activity: string): InterruptCheck {
  const rolled = new Set<string>();
  return ({ state, from, to, rng }) => {
    if (state.battle || !state.playerZone || !state.parties.length || guardedHere(content, state)) return null;
    const me = state.characters[state.playerId];
    if (!me || me.dead) return null;
    // 플레이어가 낄 교전에 부대가 닿는 시각에 멈춘다 (닿을 때 계산: 그때 예정된 교전이 되어 전투 장면이 열린다)
    for (const party of state.parties) {
      if (party.done || party.task.kind !== "clash") continue;
      const at = arrivalOf(party);
      if (at <= from || at > to) continue;
      const spec = { kind: party.task.clash, attacker: party.faction, defender: party.task.defender, zone: party.goal };
      if (playerInvolvement(state, content, spec)) return { kind: "battle", detail: "교전", at };
    }
    const asleep = activity === "sleep";
    const watched = asleep && campWatched(content, state, activity);
    const guarding = activity === "guard_duty";
    for (const { party, at } of arrivingParties(state, from, to)) {
      if (!hostileFaction(state, content, party.faction)) continue;
      const key = sightKey(party, state.playerZone, at);
      if (rolled.has(key)) continue;
      rolled.add(key);
      const r = rollPartySight(state, content, rng, party, at, { asleep, watched, guarding });
      if (r.player || r.attacks) return { kind: "disturbance", detail: `${PARTY_INTERRUPT}:${party.id}:${r.player ? 1 : 0}${r.party ? 1 : 0}${r.attacks ? 1 : 0}`, at };
    }
    return null;
  };
}

/** 부대를 본 글 (대략의 규모·온 쪽·무리 표식은 아는 무리일 때만, 목적은 쓰지 않는다. 원칙 4) */
function sightLine(state: GameState, content: Content, party: Party, at: number): string {
  const zone = state.playerZone!;
  const me = state.characters[state.playerId];
  const ours = !!me?.factionId && me.factionId === party.faction;
  const who = ours ? `우리 무리의 ${partyLabel(content, party)}` : `${content.factions[party.faction]?.name ?? "낯선"} 쪽 사람들`;
  // 장소와 방향으로 (12-304): "북쪽, 철길 둑 가는 비탈로". 들어선 길이 아니라 부대가 지나는 길에서 주인공 자리와 가장 가까운 곳 (PT31 약탈자: 네 칸 떨어진 곳에서 본 것처럼 읽혔다)
  const { places } = partyPlacePath(state, content, party, zone, at);
  const here = currentPlace(state, content)?.id ?? null;
  const nearest = here && places.length ? [...places].sort((a, b) => stepsBetween(state, content, here, a, zone) - stepsBetween(state, content, here, b, zone))[0] : places[0];
  const road = nearest ? placesIn(state, content, zone).find((p) => p.id === nearest) : undefined;
  const dir = road ? directionTo(state, content, currentPlace(state, content)?.id ?? null, road.id, zone) : null;
  const from = road ? `${dir ? `${dir}, ` : ""}${josa(road.name, "으로/로")} ` : "";
  return `${from}${forceWords(party.size)}의 ${josa(who, "이/가")} 이 구역에 들어섰다`;
}

/** 마주침을 기록하고 GM에게 줄 말. 부대가 덤비면 매복당한 채로 (9.5.2 B) */
export function settleSighting(ctx: ToolContext, party: Party, roll: SightRoll, at: number): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  if (!zone) return [];
  store.append({ type: "party_sighted", key: sightKey(party, zone, at), player: roll.player, party: roll.party });
  // 맞붙는 중인 무리는 새로 "본" 일이 아니다: 맞붙음이 끝날 때 한 줄로 남는다 (PT33 두 판: 쫓아온 정찰대가 구역마다 "지나가는 것을 봤다")
  if (state.partyFights[party.id]) return [];
  const displays: ToolDisplayEvent[] = [];
  const me = state.characters[state.playerId];
  const ours = !!me?.factionId && me.factionId === party.faction;
  if (roll.player && ours) {
    // 우리 무리 부대는 적이 아니다: 믿음으로 남기지 않고 고를 일도 없다 (PT31: 우리 순찰대에도 "숨기·맞서기"가 붙었다)
    displays.push({ type: "belief", fact: sightLine(state, content, party, at), sourceLabel: "본 것", note: "우리 무리 사람들이 지나간다. 배경으로만 서술한다." });
  } else if (roll.player) {
    const line = sightLine(state, content, party, at);
    // 본 부대는 믿음으로 남는다 (8-1): 본 때·구역·대략의 규모·온 길. 목적은 넣지 않는다
    store.append({
      type: "belief_added",
      characterId: state.playerId,
      belief: { id: `b_${state.nextBeliefNo}`, fact: `${formatTime(at)}께 ${content.locations[zone]?.name ?? zone}에서 ${line.replace(/ 이 구역에 들어섰다$/, party.goal === zone && !party.done ? " 와서 자리를 잡는 것을 봤다" : " 지나가는 것을 봤다")}`, source: "seen", accuracy: "approximate", learnedAt: state.time, topic: "war" },
    });
    displays.push({ type: "belief", fact: line, sourceLabel: "본 것", note: `${line}. 몇 명인지는 대략으로만, 무엇을 하러 왔는지는 지어내지 않는다. 숨기·피하기·지켜보기·맞서기는 플레이어가 고른다.` });
  }
  // 주인공이 매복해 있었는데 저쪽이 알아챘으면 매복은 깨진다 (PT32 졸병: 매복 +1과 매복당함 -2가 한 판정에 함께 붙었다)
  if (roll.party && state.ambush) store.append({ type: "ambush_changed", ambush: null });
  if (roll.attacks) {
    // 서로 봤으면 어느 쪽도 기습이 아니다. 저쪽만 봤을 때만 매복당함
    if (!roll.player) {
      const ambushHours = content.scenario.ambush?.hours ?? 2;
      store.append({ type: "ambushed_changed", until: state.time + Math.min(2, ambushHours) * 60 });
    }
    const line = roll.player ? "저쪽도 이쪽을 봤다. 덤벼 온다" : "누군가 먼저 이쪽을 봤다. 낌새를 챘을 때는 이미 덤벼 오고 있다";
    displays.push({ type: "belief", fact: line, sourceLabel: "본 것", note: `${line}${roll.player ? "" : " (매복당함: 다음 판정이 불리하다)"}. 상대 규모는 ${forceWords(party.size)}. 싸움이 되면 위험을 먼저 선언한다.` });
    // 덤벼 오면 실제로 맞붙음이 열린다 (PT32 세 판: "덤벼 온다"인데 아무 일도 열리지 않았다)
    const now = store.getState();
    if (!now.battle && !now.partyFights[party.id]) {
      const fight = startPartyFight(ctx, party, { byParty: true });
      if (fight.ok) displays.push({ type: "belief", fact: "", sourceLabel: "", note: fight.resultText });
    }
  }
  return displays;
}

/** 빨리감기가 부대 때문에 멈췄다: 그 부대의 마주침을 정리한다 */
export function runPartyInterrupt(ctx: ToolContext, detail: string): ToolDisplayEvent[] {
  const [, id, bits] = detail.split(":");
  const party = ctx.store.getState().parties.find((p) => p.id === id);
  if (!party || !bits) return [];
  return settleSighting(ctx, party, { player: bits[0] === "1", party: bits[1] === "1", attacks: bits[2] === "1" }, ctx.store.getState().time);
}

/**
 * 시간이 흐른 뒤: 지금 주인공 구역에 있는 부대와 아직 굴리지 않았으면 굴린다 (빨리감기 밖의 짧은 행동·이동, 9-3).
 * 우호·중립 부대는 본 것만 알리고 멈추지 않는다
 */
export function runPartySightings(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  const me = state.characters[state.playerId];
  if (!zone || !me || me.dead || state.battle || !state.parties.length || guardedHere(content, state)) return [];
  const displays: ToolDisplayEvent[] = [];
  for (const party of [...state.parties].sort((a, b) => a.id.localeCompare(b.id))) {
    if (party.size <= 0 || partyZoneAt(party, state.time) !== zone || store.getState().partySightings[sightKey(party, zone, state.time)]) continue;
    const roll = rollPartySight(store.getState(), content, rng, party, state.time);
    // 굴리지 않았으면(실내·멀다) 기록하지 않는다: 밖으로 나오거나 가까워지면 그때 굴린다 (PT31 떠돌이: 초소 안에서 한 번 넘긴 순찰대를 참호에서 다시 못 봤다)
    if (!roll.rolled) continue;
    displays.push(...settleSighting(ctx, party, roll, state.time));
  }
  return displays;
}

/** GM 상태: 지금 구역에서 본 부대 (원칙 4: 본 것만, 대략으로) */
/** 본 무리 가운데 아직 알리지 않은, 나가는 길의 적대 무리 (알리기 5-3). 무리에 속한 주인공만 */
export function alertablePartiesLines(state: GameState, content: Content): string[] {
  if (!state.characters[state.playerId]?.factionId) return [];
  // 본 지 하루 안의 적대 무리 (12-327: 물러간 정찰도 공세의 예고라 알릴 수 있다)
  return Object.entries(state.partyIntel)
    .filter(([id, i]) => state.time - i.at <= MINUTES_PER_DAY && !state.partyAlerts.some((a) => a.partyId === id) && hostileFaction(state, content, i.faction))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, i]) => {
      const live = state.parties.some((p) => p.id === id && p.size > 0 && !p.done);
      return `- ${id}: ${partyLabel(content, { faction: i.faction, kind: i.kind } as Party)} ${forceWords(i.size)} (${formatTime(i.at)}께 봤거나 들었다${live ? "" : ", 이미 물러감: 알리기만"})`;
    });
}

export function seenPartiesLines(state: GameState, content: Content): string[] {
  const zone = state.playerZone;
  if (!zone) return [];
  return state.parties
    .filter((p) => p.size > 0 && partyZoneAt(p, state.time) === zone && state.partySightings[sightKey(p, zone, state.time)]?.player)
    .map((p) => `- ${sightLine(state, content, p, state.time).replace(/ 이 구역에 들어섰다$/, " 이 구역에 있다")} (id: ${p.id}${state.partyFights[p.id] ? ", 맞붙는 중" : ""})`);
}
