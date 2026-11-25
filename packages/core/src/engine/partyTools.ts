import { sightKey } from "./partySight.ts";
import { z } from "zod";
import type { BattleState, Clash, GameState, Party } from "../game/state.ts";
import { heldOf } from "../rules/held.ts";
import { ownedBy } from "../rules/home.ts";
import { hearNews } from "../rules/news.ts";
import { companyHere } from "../rules/company.ts";
import { harmIncapacitates, incapacitatingSymptom } from "../scenario/scenario.ts";
import { battleConfig } from "../sim/battle.ts";
import { chaseInto, partyLabel, partyZoneAt, recordDefeat, routParty } from "../sim/parties.ts";
import { DEFENSE_COMMIT, frontierTarget, neighbors, type WarWorld } from "../sim/war.ts";
import type { Content } from "../content/schemas.ts";
import type { Rng } from "../rng.ts";
import { josa } from "../text.ts";
import { forceWords } from "./battleTools.ts";
import { createExtraCharacter, enterScene, noteFirstMeeting } from "./extras.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 길 위의 부대와 맞붙기 (docs/war-parties-plan.md 파트 5-1·6-1, 움직이는 부대 ③-2).
 * - 작은 부대(6명 이하)이거나 주인공이 무소속이면 작은 싸움: 부대원을 엑스트라로 장면에 들인다(보이는 사람은 여섯까지, 우두머리가 있으면 그 사람도).
 *   절반이 쓰러지거나 우두머리가 쓰러지면 부대가 달아나고, 주인공이 자리를 뜨거나 쓰러지면 부대는 쓰러진 사람만 잃고 갈 길을 간다
 * - 7명 이상 부대와 무리에 속한 주인공이면 전투 장면: 우리 편은 주인공 일행(+ 우리 땅이면 지키는 병력), 결과는 그 부대에
 * - 우두머리를 잃으면 그 무리의 공격 계획(클락)이 찬 칸의 절반으로 (6-1)
 */

const SMALL_MAX = 6;

/** 장면에서 본 부대 (지금 이 구역에 있고, 주인공이 봤다) */
function seenHere(state: GameState, party: Party): boolean {
  const zone = state.playerZone;
  return !!zone && party.size > 0 && partyZoneAt(party, state.time) === zone && !!state.partySightings[sightKey(party, zone, state.time)]?.player;
}

/** 부대를 붙잡아 둔다: 지금 칸을 minutes만큼 늘리고 뒤의 일정을 미룬다 (맞붙은 동안 떠나지 않는다) */
function holdParty(party: Party, now: number, minutes: number): Party {
  const shift = (legs: Party["legs"]) => legs.map((l) => (l.to < now ? l : { from: l.from <= now ? l.from : l.from + minutes, to: l.to + minutes, zone: l.zone }));
  return { ...party, legs: shift(party.legs), back: shift(party.back) };
}

function worldOf(state: GameState): WarWorld {
  return { factions: structuredClone(state.factions), zones: structuredClone(state.zones), clocks: structuredClone(state.clocks), parties: structuredClone(state.parties), nextPartyNo: state.nextPartyNo, partiesUpTo: state.partiesUpTo };
}

/** 부대·세력이 바뀐 것을 남긴다 (parties_advanced: 닿을 때 계산과 같은 이벤트). clashes는 구역의 교전 기록으로 남는다 */
function saveWorld(ctx: ToolContext, world: WarWorld, clashes: Clash[] = []) {
  const state = ctx.store.getState();
  ctx.store.append({
    type: "parties_advanced",
    factions: world.factions,
    zones: world.zones,
    clocks: Object.fromEntries(Object.entries(world.clocks).map(([id, c]) => [id, { filled: c.filled }])),
    parties: world.parties ?? [],
    partiesUpTo: Math.max(state.partiesUpTo, world.partiesUpTo ?? 0),
    clashes,
    scheduled: [],
  });
}

/** 우두머리를 잃었다: 그 무리의 공격 계획이 찬 칸의 절반으로 (6-1) */
function leaderLost(ctx: ToolContext, world: WarWorld, factionId: string) {
  for (const [id, clock] of Object.entries(world.clocks)) {
    const plan = ctx.content.factions[factionId]?.plans.find((p) => p.id === id);
    if (clock.factionId !== factionId || plan?.kind === "shift") continue;
    clock.filled = Math.floor(clock.filled / 2);
  }
}

export const engageParty = defineTool({
  name: "engage_party",
  description:
    "눈에 띈 무리(상태의 '눈에 띈 무리'에 적힌 id)에 맞선다. 플레이어가 덤비기로 했을 때만. 숨기·피하기·지켜보기는 이 도구가 아니다(take_action). " +
    "작은 무리면 부대원이 엑스트라로 장면에 들어오고 그 뒤로는 take_action 싸움 판정으로 한다(절반이 쓰러지거나 우두머리가 쓰러지면 달아난다). " +
    "큰 무리(7명 이상)이고 플레이어가 무리에 속해 있으면 전투 장면이 열린다. 몇 명인지·이길지는 시스템이 정한다. 매복해 두었으면(take_action.ambush) 첫 공격이 유리하다.",
  schema: z.strictObject({
    party_id: z.string().describe("상태의 '눈에 띈 무리' 줄의 id"),
  }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const me = state.characters[state.playerId];
    if (!me || me.dead) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
    if (state.battle) return { ok: false, error: "이미 전투 중이다." };
    const party = state.parties.find((p) => p.id === input.party_id);
    if (!party || !seenHere(state, party)) return { ok: false, error: `지금 이 구역에서 본 무리가 아니다: ${input.party_id} (상태의 '눈에 띈 무리'를 본다)` };
    if (state.partyFights[party.id]) return { ok: false, error: "이미 맞붙은 무리다. take_action으로 싸운다." };
    // 우리 무리 부대에는 덤비지 않는다 (PT31 분대장: 우리 순찰대가 맞서는 엑스트라로 들어왔다). 무리를 배신하려면 이야기·행동으로
    if (me.factionId && party.faction === me.factionId) return { ok: false, error: "우리 무리 사람들이다. engage_party는 다른 무리의 무리에만 쓴다." };
    return startPartyFight(ctx, party);
  },
});

/**
 * 부대와 맞붙는다 (engage_party, 또는 부대가 먼저 보고 덤벼 왔을 때 byParty). 작은 싸움이면 부대원이 엑스트라로 장면에, 큰 부대와 무리에 속한 주인공이면 전투 장면
 */
export function startPartyFight(ctx: ToolContext, party: Party, opts: { byParty?: boolean } = {}): ToolOutcome {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
    const zone = state.playerZone!;
    const label = partyLabel(content, party);
    const world = worldOf(state);
    const held = holdParty(party, state.time, 60);
    world.parties = (world.parties ?? []).map((p) => (p.id === party.id ? held : p));
    // 큰 무리와 무리에 속한 주인공: 전투 장면 (5-1)
    if (party.size > SMALL_MAX && me.factionId && content.scenario.battle) {
      saveWorld(ctx, world);
      const group = 1 + companyHere(state, content).length;
      const defenders = ownedBy(state, zone, me.factionId) ? Math.round((state.factions[me.factionId]?.combatants ?? 0) * DEFENSE_COMMIT) : 0;
      const config = battleConfig(content);
      const battle: BattleState = {
        id: `battle_${state.nextBattleNo}`,
        kind: "skirmish",
        attacker: party.faction,
        defender: me.factionId,
        zone,
        side: "defense",
        ours: { faction: me.factionId, committed: group + defenders, losses: 0 },
        theirs: { faction: party.faction, committed: party.size, losses: 0 },
        momentum: 0,
        alarm: 0,
        position: config.positions[0]!.id,
        round: 0,
        objectives: config.objectives.map((o) => o.id),
        contribution: 0,
        startedAt: state.time,
        holds: 0,
        party: party.id,
      };
      store.append({ type: "battle_started", pendingId: battle.id, battle, barrierUsed: [] });
      return {
        ok: true,
        resultText: `${opts.byParty ? `${josa(label, "이/가")} 덤벼 왔다.` : `${josa(label, "과/와")} 맞붙었다.`} 전투 장면이 열린다: 적은 ${forceWords(party.size)}, 우리 편은 ${forceWords(group + defenders)}. 전투 중 행동은 take_action.battle.`,
        display: { type: "battle", event: "started", title: `${content.locations[zone]?.name ?? zone}의 맞붙음`, detail: `${label} ${forceWords(party.size)}` },
      };
    }
    // 작은 싸움: 부대원을 엑스트라로 (보이는 사람은 여섯까지)
    const templateId = content.factions[party.faction]?.party_extra ?? Object.values(content.extras).find((t) => t.faction === party.faction)?.id;
    const template = templateId ? content.extras[templateId] : undefined;
    if (!template) return { ok: false, error: `${label}의 사람을 장면에 들일 엑스트라 틀이 없다.` };
    saveWorld(ctx, world);
    const members: string[] = [];
    const leader = party.leader && state.characters[party.leader] && !state.characters[party.leader]!.dead ? party.leader : null;
    if (leader) {
      enterScene(ctx, leader);
      members.push(leader);
    }
    const visible = Math.min(party.size - members.length, SMALL_MAX);
    for (let i = 0; i < visible; i++) {
      const now = store.getState();
      const id = `ex_${now.nextExtraNo}`;
      const usedNames = new Set(Object.values(now.characters).map((c) => c.name));
      const usedLooks = new Set(Object.values(now.characters).flatMap((c) => (c.extra ? [c.extra.look] : [])));
      const character = createExtraCharacter(content, template, { id, label: `${label} ${i + 1}`, zone, time: now.time, usedNames, usedLooks }, rng);
      // 엑스트라는 만들어지며 장면에 들어온다 (spawn_extra와 같다)
      store.append({ type: "extra_spawned", character });
      noteFirstMeeting(ctx, id);
      members.push(id);
    }
    store.append({ type: "party_engaged", partyId: party.id, members, zone });
    const rest = party.size - members.length;
    return {
      ok: true,
      resultText:
        `${opts.byParty ? `${josa(label, "이/가")} 덤벼 왔다.` : `${josa(label, "과/와")} 맞붙었다.`} 장면에 들어온 사람: ${members.join(", ")}${rest > 0 ? ` (뒤에 ${forceWords(rest)}이 더 있다)` : ""}. ` +
        `이제 take_action 싸움 판정으로 한다(target·target_harm). 절반이 쓰러지거나${leader ? " 우두머리가 쓰러지거나" : ""} 하면 무리가 달아난다. 몸의 위험을 먼저 선언한다. 달아나려면 판정을 걸고 자리를 옮긴다(place_to·move_to + check): 빗나가면 쫓아와 맞붙음이 이어진다.`,
      display: { type: "presence", npcName: label, action: "enter", note: `${label} ${forceWords(party.size)}과 맞붙었다` },
    };
}

/** 지금 구역에서 맞붙은 부대원 (판정을 건 이동이 빗나가면 쫓아온다, PT32 사용자 결정) */
export function fightMembersHere(state: GameState): string[] {
  return Object.values(state.partyFights).filter((f) => f.zone === state.playerZone).flatMap((f) => f.members);
}

/** 맞붙은 주인공이 옆 구역으로 달아나다 빗나가 부대원이 쫓아왔다: 맞붙음과 부대 자리를 그 구역으로 옮긴다 (부대는 하던 일을 접는다) */
export function chaseParties(ctx: ToolContext, from: string, to: string, chasing: readonly string[]): void {
  const state = ctx.store.getState();
  const fights = Object.entries(state.partyFights).filter(([, f]) => f.zone === from && f.members.some((id) => chasing.includes(id)));
  if (!fights.length) return;
  const world = worldOf(state);
  for (const [partyId] of fights) chaseInto(world, ctx.content, ctx.rng, partyId, to, state.time, 60);
  saveWorld(ctx, world);
  for (const [partyId, f] of fights) {
    ctx.store.append({ type: "party_engaged", partyId, members: [...f.members], zone: to });
    // 쫓아온 무리는 도착한 구역에서도 "눈에 띈 무리"다 (PT33 분대장: 거점까지 쫓겨 오자 무리 줄이 사라졌다)
    const party = ctx.store.getState().parties.find((x) => x.id === partyId);
    if (party) ctx.store.append({ type: "party_sighted", key: sightKey(party, to, state.time), player: true, party: true });
  }
}

export const PARTY_TOOLS = [engageParty] as const;

const downedNow = (ctx: ToolContext, id: string) => {
  const c = ctx.store.getState().characters[id];
  return !c || c.dead || !!heldOf(c) || harmIncapacitates(ctx.content.scenario, c) || !!incapacitatingSymptom(ctx.content.scenario, c);
};

/**
 * 맞붙은 싸움을 살핀다 (시간이 흐른 뒤마다): 절반이 쓰러지거나 우두머리가 쓰러지면 부대가 달아나고,
 * 주인공이 자리를 떴거나 쓰러졌으면 부대는 쓰러진 사람만 잃고 갈 길을 간다. 쓰러진 사람은 그 자리에 남는다
 */
export function runPartyFights(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content, rng } = ctx;
  const displays: ToolDisplayEvent[] = [];
  for (const [partyId, fight] of Object.entries(store.getState().partyFights)) {
    const state = store.getState();
    const party = state.parties.find((p) => p.id === partyId);
    if (!party) {
      store.append({ type: "party_fight_ended", partyId });
      continue;
    }
    const me = state.characters[state.playerId];
    const downed = fight.members.filter((id) => downedNow(ctx, id));
    const leaderDown = !!party.leader && downed.includes(party.leader);
    const rout = downed.length >= Math.ceil(fight.members.length / 2) || leaderDown;
    const playerGone = !me || me.dead || !!heldOf(me) || !!incapacitatingSymptom(content.scenario, me) || state.playerZone !== fight.zone;
    if (!rout && !playerGone) continue;
    const world = worldOf(state);
    const p = world.parties!.find((x) => x.id === partyId)!;
    p.size = Math.max(0, p.size - downed.length);
    const f = world.factions[p.faction];
    if (f) f.population = Math.max(0, f.population - downed.length);
    if (rout) {
      routParty(world, content, rng, partyId, state.time);
      recordDefeat(world, p.faction, state.time);
      if (leaderDown) leaderLost(ctx, world, p.faction);
    }
    // 우리 땅이나 맞닿은 곳에서 우리 무리 주인공과 맞붙은 일은 그 구역의 교전으로 남는다 (PT33 사용자 결정: 전선이 바쁜 날·싸움터 수습하기·흔적의 계기)
    const mine = me?.factionId ?? null;
    const near = !!mine && (ownedBy(state, fight.zone, mine) || neighbors(content, fight.zone).some((n) => ownedBy(state, n, mine)));
    const meDown = !me || me.dead || !!incapacitatingSymptom(content.scenario, me) || harmIncapacitates(content.scenario, me);
    const clash: Clash[] = near && mine && mine !== p.faction ? [{ kind: "skirmish", attacker: p.faction, defender: mine, zone: fight.zone, success: !rout, attackerLosses: downed.length, defenderLosses: meDown ? 1 : 0 }] : [];
    saveWorld(ctx, world, clash);
    store.append({ type: "party_fight_ended", partyId });
    const label = partyLabel(content, party);
    // 맞붙은 일은 한 줄로 남는다 (본 것). 정신을 잃은 사이 끝났으면 깨어나 알게 된다 (PT33 분대장: 의식을 잃은 사이 떠났는데 아무 기록이 없었다)
    if (me && !me.dead) {
      const where = content.locations[fight.zone]?.name ?? fight.zone;
      const topic = josa(label, "은/는");
      const end = rout ? `${topic} 무너져 달아났다` : meDown ? `${topic} 정신을 잃은 사이 물러갔다` : state.playerZone === fight.zone ? `${topic} 더 엮이지 않고 갈 길을 갔다` : "쫓아오는 것을 떨쳐 냈다";
      hearNews(ctx, { fact: `${where}에서 ${josa(label, "과/와")} 맞붙었다. ${end}.`, factions: [p.faction], seen: true, topic: "war", once: true });
    }
    // 쓰러지지 않은 사람은 장면을 떠난다
    for (const id of fight.members) if (!downed.includes(id) && store.getState().scene.present.includes(id)) store.append({ type: "npc_left", npcId: id });
    if (rout) {
      const line = `${josa(label, "이/가")} 무너져 달아났다${leaderDown ? " (이끌던 사람이 쓰러졌다)" : ""}. 쓰러진 ${downed.length}명은 그 자리에 남았다.`;
      displays.push({ type: "belief", fact: line, sourceLabel: "본 것", note: `${line} 달아나는 장면을 서술한다. 쓰러진 사람의 소지품은 판정 없이 뒤질 수 있다.` });
    } else if (state.playerZone === fight.zone && me && !me.dead) {
      displays.push({ type: "belief", fact: `${josa(label, "은/는")} 더 엮이지 않고 갈 길을 갔다.`, sourceLabel: "본 것" });
    }
  }
  return displays;
}

/**
 * 포로가 털어놓는 전쟁 이야기 (6-2): 그 무리의 나가 있는 부대 하나의 목표, 또는 다음 공세의 목표 구역. 이름 있는 대원은 둘을 안다.
 * 대가 있는 성공이면 반은 틀린 목표를 말한다. 주인공은 믿음으로만 알고 맞는지는 모른다 (accuracy false로 남긴다)
 */
export function warConfessions(state: GameState, content: Content, rng: Rng, prisonerId: string, outcome: "success" | "partial"): { fact: string; accuracy: "approximate" | "false" }[] {
  const p = state.characters[prisonerId];
  const fid = p?.factionId;
  if (!p || !fid || !content.factions[fid]) return [];
  const name = content.factions[fid]!.name;
  const zoneName = (z: string) => content.locations[z]?.name ?? z;
  const lie = (truth: string) => {
    if (outcome !== "partial" || rng() >= 0.5) return null;
    const others = Object.keys(content.locations).filter((z) => z !== truth && content.locations[z]?.kind !== "base").sort();
    return others.length ? others[Math.floor(rng() * others.length)]! : null;
  };
  const known: { fact: (z: string) => string; zone: string }[] = [];
  for (const party of state.parties.filter((x) => x.faction === fid && !x.done && x.size > 0).sort((a, b) => a.id.localeCompare(b.id))) {
    known.push({ zone: party.goal, fact: (z) => `${name} 쪽 ${partyLabel(content, party)}이 ${zoneName(z)} 쪽으로 나가 있다고 포로가 털어놓았다` });
  }
  for (const [id, clock] of Object.entries(state.clocks).sort(([a], [b]) => a.localeCompare(b))) {
    const plan = content.factions[fid]!.plans.find((x) => x.id === id);
    if (clock.factionId !== fid || plan?.kind === "shift") continue;
    const target = clock.target || frontierTarget(state, content, fid);
    if (target) known.push({ zone: target, fact: (z) => `${name} 쪽이 ${zoneName(z)}을 칠 준비를 하고 있다고 포로가 털어놓았다` });
  }
  const count = content.npcs[prisonerId] ? 2 : 1;
  return known.slice(0, count).map((k) => {
    const wrong = lie(k.zone);
    return { fact: k.fact(wrong ?? k.zone), accuracy: wrong ? "false" : "approximate" };
  });
}
