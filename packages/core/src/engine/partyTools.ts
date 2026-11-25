import { sightKey } from "./partySight.ts";
import { z } from "zod";
import type { BattleState, Clash, GameState, Party } from "../game/state.ts";
import { heldOf } from "../rules/held.ts";
import { baseOfNow, hostileFaction, ownedBy } from "../rules/home.ts";
import { rollPlayerCheck } from "./checks.ts";
import { stakesOf } from "../rules/stakes.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { disciplineOf } from "../game/culture.ts";
import { formatTime } from "../rules/time.ts";
import { hearNews } from "../rules/news.ts";
import { companyHere } from "../rules/company.ts";
import { harmIncapacitates, incapacitatingSymptom } from "../scenario/scenario.ts";
import { battleConfig } from "../sim/battle.ts";
import { arrivalOf, canSend, chaseInto, partiesConfig, partyLabel, partyZoneAt, recordDefeat, routParty, spawnIntercept } from "../sim/parties.ts";
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

/** 무리의 계급 높이 */
const rankLevel = (content: Content, rank: string | undefined) => content.scenario.rank_ladder.find((r) => r.id === rank)?.level ?? 0;

/** 장면에 있는 우리 무리 윗사람 (상관이거나 계급이 더 높은 사람). 알리고 설득할 상대 */
function superiorHere(state: GameState, content: Content): string | null {
  const me = state.characters[state.playerId];
  if (!me?.factionId) return null;
  const mine = rankLevel(content, me.rank);
  const commander = content.roles[state.roleId]?.commander;
  return (
    state.scene.present
      .filter((id) => {
        const c = state.characters[id];
        return !!c && !c.dead && c.factionId === me.factionId && (id === commander || rankLevel(content, c.rank) > mine);
      })
      .sort((a, b) => rankLevel(content, state.characters[b]!.rank) - rankLevel(content, state.characters[a]!.rank) || a.localeCompare(b))[0] ?? null
  );
}

export const alertParty = defineTool({
  name: "alert_party",
  description:
    "주인공이 본 다른 무리의 무리(상태의 '본 무리'·'눈에 띈 무리' id)를 우리 무리에 알린다 (움직이는 부대 5-3). 우리 거점에 있거나 윗사람(상관·더 높은 계급)이 장면에 있을 때. " +
    "알리면 무리가 그 무리가 노리는 우리 구역을 더 지킨다. persuade: true면 맞받아치자고 설득한다 (윗사람이 장면에 있어야, approach는 교섭·전략 스킬): 받아들여지면 무리가 가로막을 부대를 낸다. " +
    "결과는 코드가 정한다. 같은 무리는 한 번만 알린다.",
  schema: z.strictObject({
    party_id: z.string().describe("본 무리의 id"),
    persuade: z.boolean().default(false).describe("맞받아치자고 설득하면 true"),
    approach: z.string().nullable().default(null).describe("설득에 쓰는 스킬 id (교섭·전략)"),
    stat: z.string().nullable().default(null).describe("그 스킬에 쓰는 능력 id"),
    intent: z.string().max(200).nullable().default(null).describe("무엇을 근거로 설득하는지 한 줄"),
  }),
  run(input, ctx) {
    const { store, content, rng } = ctx;
    const state = store.getState();
    const me = state.characters[state.playerId];
    if (!me || me.dead) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
    if (!me.factionId) return { ok: false, error: "알릴 무리가 없다 (무소속)." };
    const party = state.parties.find((p) => p.id === input.party_id);
    if (!party || state.partiesSeen[party.id] === undefined) return { ok: false, error: `본 적 있는 무리가 아니다: ${input.party_id}` };
    if (!hostileFaction(state, content, party.faction)) return { ok: false, error: "우리를 적대하는 무리만 알린다." };
    if (party.size <= 0 || party.done) return { ok: false, error: "이미 물러간 무리다. 알려도 무리가 할 일이 없다." };
    if (state.partyAlerts.some((a) => a.partyId === party.id)) return { ok: false, error: "이미 알린 무리다. 같은 무리로 다시 조르지 못한다." };
    const base = baseOfNow(state, content, me.factionId);
    const boss = superiorHere(state, content);
    if (!boss && state.playerZone !== base) return { ok: false, error: "알릴 사람이 없다. 우리 거점으로 가거나 상관·윗사람을 장면에 들인다." };
    if (input.persuade && !boss) return { ok: false, error: "맞받아치자고 말할 윗사람이 장면에 없다. 상관이나 더 높은 사람을 npc_presence로 들인다." };
    const label = partyLabel(content, party);
    const zone = party.goal;
    const ours = ownedBy(state, zone, me.factionId);
    const zoneName = content.locations[zone]?.name ?? zone;
    const lines = [`${josa(label, "을/를")} 무리에 알렸다.${ours ? ` 무리는 그쪽이 ${josa(zoneName, "을/를")} 노린다고 보고 그곳을 더 지킨다.` : " 노리는 곳이 우리 땅이 아니라 지킬 곳을 늘리지는 않는다."} 알린 무리가 와서 막히면 공이 된다.`];
    let persuaded: "none" | "success" | "partial" | "miss" = "none";
    let display: ToolDisplayEvent = { type: "belief", fact: `${label}을 무리에 알렸다`, sourceLabel: "한 일" };
    if (input.persuade) {
      const moves = content.scenario.command?.council_moves ?? [];
      if (!input.approach || !moves.includes(input.approach)) return { ok: false, error: `설득에 쓰는 스킬이 아니다 (가능: ${moves.join(", ") || "없음"})` };
      if (!input.stat) return { ok: false, error: "stat(능력 id)이 필요하다." };
      // 윗사람이 나를 믿으면 쉽고 못 믿으면 어렵다(지도부 회의와 같은 셈의 ±2 문턱), 군율 무리에서 분대장 아래의 말은 한 단계 어렵다 (*임시*)
      const trust = (state.relations[boss!]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
      const steps = ["very_easy", "easy", "normal", "hard", "very_hard"] as const;
      let at = trust >= 2 ? 1 : trust <= -2 ? 3 : 2;
      const lowRank = rankLevel(content, me.rank) < rankLevel(content, "squad_leader");
      if (disciplineOf(content, me.factionId).id === "strict" && lowRank) at = Math.min(4, at + 1);
      const check = rollPlayerCheck({ move: input.approach, stat: input.stat, difficulty: steps[at]!, intent: input.intent ?? `${label}을 가로막자고 말한다` }, ctx, { stakes: stakesOf({ activity: true }) });
      if (!check.ok) return check;
      persuaded = check.outcome === "success" ? "success" : check.outcome === "partial" ? "partial" : "miss";
      display = check.display;
      const bossName = playerCalls(store.getState(), content, boss!);
      const cfg = partiesConfig(content);
      if (persuaded === "miss") lines.push(`${josa(bossName, "은/는")} 맞받아치자는 말을 받아들이지 않았다. 지키기만 한다.`);
      else {
        const world = worldOf(store.getState());
        const size = persuaded === "success" ? party.size : Math.max(1, Math.ceil(party.size / 2));
        const enemyAt = arrivalOf(party);
        const sent = cfg && base && canSend(world, cfg, me.factionId, size, "raid") ? spawnIntercept(world, content, { faction: me.factionId, from: base, goal: zone, size, at: store.getState().time, until: Math.max(enemyAt, store.getState().time) + 120, by: state.playerId }) : null;
        if (!sent) lines.push(`${josa(bossName, "은/는")} 맞받아칠 뜻은 있지만 지금 내보낼 사람이 없다고 한다. 지키기만 한다.`);
        else {
          saveWorld(ctx, world);
          lines.push(`${josa(bossName, "이/가")} 맞받아치자는 말을 받아들였다${persuaded === "partial" ? " (다만 작게)" : ""}. 무리가 ${forceWords(size)}을 ${josa(zoneName, "으로/로")} 내보내 숨어 기다리게 한다 (${formatTime(sent.task.kind === "intercept" ? sent.task.until : enemyAt)}까지). 결과는 코드가 정하고 소식으로 돌아온다.`);
        }
      }
    }
    store.append({ type: "party_alerted", partyId: party.id, faction: me.factionId, zone, persuaded });
    lines.push("알리는 장면을 서술한다. 무리가 무엇을 할지는 이 결과대로만.");
    void rng;
    return { ok: true, resultText: lines.join("\n"), display };
  },
});

/** 분대 가로막기 (5-4): 나선 분대원들이 실제 부대가 되어 그 구역에 숨어 기다린다. 첫 사람이 이끈다. 낸 부대 id (못 내면 null) */
export function sendSquadIntercept(ctx: ToolContext, members: readonly string[], zone: string, until: number): string | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me?.factionId || !members.length || !state.playerZone) return null;
  const world = worldOf(state);
  const party = spawnIntercept(world, ctx.content, { faction: me.factionId, from: state.playerZone, goal: zone, size: members.length, at: state.time, until, squad: [...members], by: state.playerId, leader: members[0]! });
  if (!party) return null;
  saveWorld(ctx, world);
  return party.id;
}

/** 분대 가로막기의 결과를 거두고 기록을 지운다 (보고할 때). 아직 돌아오는 중이면 남은 사람은 전투원으로 */
export function collectSquadIntercept(ctx: ToolContext, memberId: string): { party: Party; result: Extract<Party["task"], { kind: "intercept" }>["result"] } | null {
  const state = ctx.store.getState();
  const party = state.parties.find((p) => p.task.kind === "intercept" && p.task.squad.includes(memberId));
  if (!party || party.task.kind !== "intercept") return null;
  const world = worldOf(state);
  const f = world.factions[party.faction];
  if (f && party.size > 0) f.combatants += party.size;
  world.parties = (world.parties ?? []).filter((p) => p.id !== party.id);
  saveWorld(ctx, world);
  return { party, result: party.task.result };
}

/**
 * 알린 무리의 끝 (5-3): 그 무리가 노리던 우리 구역을 쳤다가 막히면 공적 +1과 소식, 그 무리가 물러가거나 사라지면 더 지키던 것을 거둔다
 */
export function settlePartyAlerts(ctx: ToolContext, clashes: readonly Clash[]): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const out: ToolDisplayEvent[] = [];
  for (const alert of store.getState().partyAlerts.filter((a) => !a.credited)) {
    const state = store.getState();
    const blocked = clashes.find((c) => c.zone === alert.zone && c.defender === alert.faction && c.kind !== "occupy" && !c.success && state.parties.find((p) => p.id === alert.partyId)?.faction === c.attacker);
    const party = state.parties.find((p) => p.id === alert.partyId);
    if (blocked) {
      store.append({ type: "party_alert_settled", partyId: alert.partyId, zone: alert.zone, credited: true, clear: true });
      if (state.characters[state.playerId]?.factionId === alert.faction) {
        store.append({ type: "merit_awarded", characterId: state.playerId, delta: 1, reason: "알린 무리를 막아 냈다" });
        out.push(...hearNews(ctx, { fact: `당신이 알린 덕에 ${content.locations[alert.zone]?.name ?? alert.zone}에서 ${partyLabel(content, party ?? { faction: blocked.attacker, kind: "raid" } as Party)}을 막아 냈다고 한다 (공적 +1).`, factions: [alert.faction] }));
      }
    } else if (!party || party.done || party.size <= 0) {
      store.append({ type: "party_alert_settled", partyId: alert.partyId, zone: alert.zone, credited: false, clear: state.zones[alert.zone]?.alerted === alert.faction });
    }
  }
  return out;
}

export const PARTY_TOOLS = [engageParty, alertParty] as const;

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
