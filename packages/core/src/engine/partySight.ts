import type { Content } from "../content/schemas.ts";
import type { GameState, Party } from "../game/state.ts";
import { canAmbush, isNight, partyChoice, partyNoticeBonus, personNoticeBonus, sightings, type Concealment } from "../rules/encounter.ts";
import { hostileFaction, ownedBy } from "../rules/home.ts";
import { companyHere } from "../rules/company.ts";
import { currentPlace, guardedHere, kindsOf } from "../rules/place.ts";
import type { Rng } from "../rng.ts";
import type { InterruptCheck } from "../sim/fastForward.ts";
import { hidingAt, partyLabel, partyZoneAt } from "../sim/parties.ts";
import { josa } from "../text.ts";
import { forceWords } from "./battleTools.ts";
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

const sightKey = (party: Party, zone: string) => `${party.id}@${zone}`;

/** 주인공 쪽 사람 수 (주인공 + 곁의 동행) */
function groupSize(state: GameState, content: Content): number {
  return 1 + companyHere(state, content).length;
}

/** 지금 자리에서 바깥이 보이는가: 바깥 장소이거나 망루. 장소가 없는 구역이면 본다 */
function outdoorsHere(state: GameState, content: Content): boolean {
  const place = currentPlace(state, content);
  return !place || !place.indoor || kindsOf(place).includes("watch");
}

export type SightRoll = { player: boolean; party: boolean; attacks: boolean };

/** 한 번 서로 알아채기를 굴린다 (공통 규칙 23). asleep이면 불침번이 있을 때만 주인공 쪽이 본다 */
export function rollPartySight(state: GameState, content: Content, rng: Rng, party: Party, at: number, opts: { asleep?: boolean; watched?: boolean } = {}): SightRoll {
  const zone = state.playerZone!;
  if (!outdoorsHere(state, content)) return { player: false, party: false, attacks: false };
  const me = state.characters[state.playerId]!;
  const cover = content.locations[zone]?.cover ?? 0;
  const night = isNight(at);
  const partyHidden: Concealment = { hiding: hidingAt(party, at), night, cover };
  const meHidden: Concealment = { hiding: !!state.ambush, night, cover };
  // 잠든 사람은 보지 못한다. 불침번은 그 사람의 눈으로 본다 (보정 없음)
  const myBonus = opts.asleep ? (opts.watched ? 0 : null) : personNoticeBonus(content, me);
  const seen = sightings(rng, { bonus: myBonus ?? -99, hidden: meHidden }, { bonus: partyNoticeBonus(party.kind), hidden: partyHidden });
  const player = myBonus !== null && seen.aSees;
  const partySaw = seen.bSees;
  // 주인공을 본 부대가 덤비는가: 적대하는 무리이고, 주인공 쪽보다 넉넉히 많을 때 (4-2)
  const onOwnLand = ownedBy(state, zone, party.faction);
  const attacks = partySaw && hostileFaction(state, content, party.faction) && partyChoice({ kind: party.kind, size: party.size, onOwnLand }, { size: groupSize(state, content) }) === "fight";
  return { player, party: partySaw, attacks };
}

/** 이 구간에 주인공 구역에 드는 부대 (아직 굴리지 않은 것). 처음 드는 시각과 함께 */
function arrivingParties(state: GameState, from: number, to: number): { party: Party; at: number }[] {
  const zone = state.playerZone;
  if (!zone) return [];
  const out: { party: Party; at: number }[] = [];
  for (const party of [...state.parties].sort((a, b) => a.id.localeCompare(b.id))) {
    if (party.size <= 0 || state.partySightings[sightKey(party, zone)]) continue;
    const leg = [...party.legs, ...party.back].find((l) => l.zone === zone && l.to > from && l.from <= to);
    if (leg) out.push({ party, at: Math.max(leg.from, from + 1) });
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
    const asleep = activity === "sleep";
    const watched = asleep && campWatched(content, state, activity);
    for (const { party, at } of arrivingParties(state, from, to)) {
      if (!hostileFaction(state, content, party.faction)) continue;
      const key = sightKey(party, state.playerZone);
      if (rolled.has(key)) continue;
      rolled.add(key);
      const r = rollPartySight(state, content, rng, party, at, { asleep, watched });
      if (r.player || r.attacks) return { kind: "disturbance", detail: `${PARTY_INTERRUPT}:${party.id}:${r.player ? 1 : 0}${r.party ? 1 : 0}${r.attacks ? 1 : 0}`, at };
    }
    return null;
  };
}

/** 부대를 본 글 (대략의 규모·온 쪽·무리 표식은 아는 무리일 때만, 목적은 쓰지 않는다. 원칙 4) */
function sightLine(state: GameState, content: Content, party: Party, at: number): string {
  const zone = state.playerZone!;
  const legs = [...party.legs, ...party.back];
  const i = legs.findIndex((l) => l.zone === zone && l.to >= at && l.from <= at);
  const cameFrom = i > 0 ? legs[i - 1]!.zone : null;
  const me = state.characters[state.playerId];
  const ours = !!me?.factionId && me.factionId === party.faction;
  const who = ours ? `우리 무리의 ${partyLabel(content, party)}` : `${content.factions[party.faction]?.name ?? "낯선"} 쪽 사람들`;
  const from = cameFrom && content.locations[cameFrom] ? `${content.locations[cameFrom]!.name} 쪽에서 ` : "";
  return `${from}${forceWords(party.size)}의 ${josa(who, "이/가")} 이 구역에 들어섰다`;
}

/** 마주침을 기록하고 GM에게 줄 말. 부대가 덤비면 매복당한 채로 (9.5.2 B) */
export function settleSighting(ctx: ToolContext, party: Party, roll: SightRoll, at: number): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  if (!zone) return [];
  store.append({ type: "party_sighted", key: sightKey(party, zone), player: roll.player, party: roll.party });
  const displays: ToolDisplayEvent[] = [];
  if (roll.player) {
    const line = sightLine(state, content, party, at);
    displays.push({ type: "belief", fact: line, sourceLabel: "본 것", note: `${line}. 몇 명인지는 대략으로만, 무엇을 하러 왔는지는 지어내지 않는다. 숨기·피하기·지켜보기·맞서기는 플레이어가 고른다.` });
  }
  if (roll.attacks) {
    const ambushHours = content.scenario.ambush?.hours ?? 2;
    store.append({ type: "ambushed_changed", until: state.time + Math.min(2, ambushHours) * 60 });
    const line = roll.player ? "저쪽도 이쪽을 봤다. 덤벼 온다" : "누군가 먼저 이쪽을 봤다. 낌새를 챘을 때는 이미 덤벼 오고 있다";
    displays.push({ type: "belief", fact: line, sourceLabel: "본 것", note: `${line} (매복당함: 다음 판정이 불리하다). 상대 규모는 ${forceWords(party.size)}. 싸움이 되면 위험을 먼저 선언한다.` });
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
    if (party.size <= 0 || partyZoneAt(party, state.time) !== zone || store.getState().partySightings[sightKey(party, zone)]) continue;
    const roll = rollPartySight(store.getState(), content, rng, party, state.time);
    displays.push(...settleSighting(ctx, party, roll, state.time));
  }
  return displays;
}

/** GM 상태: 지금 구역에서 본 부대 (원칙 4: 본 것만, 대략으로) */
export function seenPartiesLines(state: GameState, content: Content): string[] {
  const zone = state.playerZone;
  if (!zone) return [];
  return state.parties
    .filter((p) => p.size > 0 && partyZoneAt(p, state.time) === zone && state.partySightings[sightKey(p, zone)]?.player)
    .map((p) => `- ${sightLine(state, content, p, state.time).replace(/ 이 구역에 들어섰다$/, " 이 구역에 있다")}`);
}
