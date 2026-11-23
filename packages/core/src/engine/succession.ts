import { heldOf } from "../rules/held.ts";
import { checkResolve } from "./resolve.ts";
import { bindOwnLovers } from "./romance.ts";
import { resolveChronicle } from "./resolve.ts";
import { inheritStashes } from "./legacy.ts";
import { rankName } from "../game/ranks.ts";
import { autoEquip } from "./gear.ts";
import { z } from "zod";
import { nameAs } from "../game/acquaintance.ts";
import { tiesOf } from "../game/ties.ts";
import { checkCharacterChoice, checkName, fillCharacterChoice } from "../game/creation.ts";
import type { CharacterChoice } from "../game/state.ts";
import type { Belief } from "../game/belief.ts";
import { applySettingBacking } from "./background.ts";
import { createCharacterFromRole, type GameState, type RunRecord } from "../game/state.ts";
import type { Content, RoleContent } from "../content/schemas.ts";
import { buildCustomRole, joinRole } from "../game/customStart.ts";
import { formatTime, MINUTES_PER_DAY, START_TIME } from "../rules/time.ts";
import { josa, sentence } from "../text.ts";
import { defineTool, type ToolContext } from "./toolkit.ts";
import { describeClash, WAR_TOPIC } from "./warTools.ts";
import { hearNews } from "../rules/news.ts";
import { zoneOf, arrivalPlace, currentPlace, movePlayer, whereIs } from "../rules/place.ts";

/**
 * 사망과 계승 (기획서 3.1, 3.2).
 * - 사망은 부상 트랙으로만 일어나고(원칙 3), 그 순간 코드가 연대기 기록을 만든다
 * - 다음 캐릭터: 새로 만든 캐릭터, 또는 이 세계에 이미 있는(이전 캐릭터가 알던) 살아 있는 NPC
 * - 새 캐릭터는 이전 캐릭터의 기억을 모른다. 이전 캐릭터의 죽음과 큰 행적은 소문으로 남는다
 * - AI는 묘비명(짧은 회고)만 쓴다. 숫자와 사실은 코드가 정한다
 */

/** 연대기에 남길 행적 수 */
export const CHRONICLE_DEEDS = 5;

/** 지금 플레이어가 막 죽었을 때의 연대기 기록 */
export function buildRunRecord(state: GameState, cause: string): RunRecord {
  const player = state.characters[state.playerId]!;
  const deeds = Object.values(state.deeds)
    .filter((d) => d.actorId === player.id)
    .sort((a, b) => b.severity - a.severity || a.at - b.at)
    .slice(0, CHRONICLE_DEEDS)
    .map((d) => d.summary);
  return {
    characterId: player.id,
    name: player.name,
    factionId: player.factionId,
    rank: player.rank,
    startedAt: state.runStartedAt,
    diedAt: state.time,
    merit: player.merit,
    cause,
    deeds,
    epitaph: null,
  };
}

/** 사망을 기록한다. 전투 중이었으면 그 자리를 원인에 붙인다 */
export function recordDeath(ctx: ToolContext, cause: string, where: string | null): RunRecord {
  const state = ctx.store.getState();
  const record = buildRunRecord(state, where ? `${where}에서 ${cause}` : cause);
  ctx.store.append({ type: "character_died", record });
  return record;
}

export function daysSurvived(record: RunRecord): number {
  return Math.floor((record.diedAt - record.startedAt) / MINUTES_PER_DAY) + 1;
}

export type SuccessionOption = { id: string; label: string; detail: string };

/**
 * 다음 캐릭터 후보 (기획서 3.1, 12.4.1). 플레이어가 죽었을 때만 있다. 두 번째 주인공부터는 시나리오 없이 세계만 이어 간다.
 * - 새 캐릭터 (new:<세력>:<계급>): 이전 주인공들이 조우한 무리에서, 그 무리의 수색대원·분대장·간부 자리 (`custom_start.ranks`)
 * - 조우한 사람: 이전 주인공들이 이름을 알게 된, 살아 있고 플레이할 수 있는 인물 (무리의 우두머리는 뺀다)
 * 어느 쪽이든 그 무리·계급의 자리(역할)를 받는다 (heirSeat)
 */
/** 새 캐릭터 후보 id 머리 (new:<세력 id>:<계급 id>) */
export const NEW_AS_PREFIX = "new:";

/**
 * 이 판이 끝났는지 (기획서 12.4.1): 주인공이 죽었고, 지금 시나리오가 다음 캐릭터로 이어 갈 수 없거나(튜토리얼),
 * 이어 갈 사람이 없다 (아무도 만나지 못한 채 죽었다)
 */
export function storyEnded(state: GameState, content: Content): boolean {
  if (!state.characters[state.playerId]?.dead) return false;
  return content.roles[state.scenarioRole]?.scenario?.heirs === false || heirCandidates(state, content).length === 0;
}

/** 이전 주인공들(지금 죽은 사람 포함)이 이름을 알게 된 사람 */
function encountered(state: GameState): Set<string> {
  const ids = new Set<string>();
  for (const who of [state.playerId, ...state.chronicle.map((r) => r.characterId)]) for (const id of state.known[who] ?? []) ids.add(id);
  return ids;
}

/** 이전 주인공들이 얼굴이라도 마주친 사람 (무리를 조우했는지 볼 때, 12-195) */
function faced(state: GameState): Set<string> {
  const ids = encountered(state);
  for (const who of [state.playerId, ...state.chronicle.map((r) => r.characterId)]) for (const id of state.met[who] ?? []) ids.add(id);
  return ids;
}

/** 새 캐릭터 후보의 "무리 없음" 자리 (new:none:<계급>) */
const NO_FACTION = "none";

/** 이전 주인공들이 조우한 무리: 이름을 아는 사람의 무리와, 주인공들이 속했던 무리 */
export function encounteredFactions(state: GameState, content: Content): string[] {
  const out = new Set<string>();
  // 이름을 몰라도 마주친 무리 (12-195: 붉은연합에 붙잡혔다 죽은 떠돌이에게 후보가 신부 한 명뿐이었다)
  for (const id of faced(state)) {
    const f = state.characters[id]?.factionId;
    if (f && content.factions[f]) out.add(f);
  }
  for (const r of state.chronicle) if (r.factionId && content.factions[r.factionId]) out.add(r.factionId);
  return Object.keys(content.factions).filter((f) => out.has(f));
}

/** 개인 사연이 있는 시나리오 역할 (지난 일·가까운 동료·찾는 가족): 그 주인공의 것이라 다음 주인공의 자리로 쓰지 않는다 */
export const personalRole = (r: RoleContent): boolean => (r.history?.length ?? 0) > 0 || (r.background?.length ?? 0) > 0 || !!r.start_bonds || !!r.family;

/** 이 자리가 지고 들어오는 빚 한 줄 (없으면 null) */
function debtLine(content: Content, role: RoleContent | undefined): string | null {
  const debt = Object.entries(role?.start_debt ?? {});
  return debt.length ? `이 자리는 빚을 지고 들어온다: ${debt.map(([f, n]) => `${content.factions[f]?.name ?? f} ${n}`).join(", ")} (갚는 일감이나 갚는다고 건넨 물건으로 준다).` : null;
}

/**
 * 다음 주인공이 받는 자리: 그 무리·계급의 콘텐츠 역할(개인 사연이 없는 것), 없으면 코드가 만든 자리.
 * 무리가 없으면 떠돌이 자리. 첫 장면·사연·시나리오는 없다
 */
export function heirSeat(content: Content, faction: string, rank: string, who: { age: number | null; occupation?: string | null; zone?: string | null }): { role: RoleContent; custom: boolean } {
  const roles = Object.values(content.roles).sort((a, b) => Number(personalRole(a)) - Number(personalRole(b)) || a.id.localeCompare(b.id));
  const c = content.scenario.custom_start;
  if (faction) {
    const seat = roles.find((r) => r.faction === faction && r.rank === rank && !personalRole(r));
    if (seat) return { role: seat, custom: false };
    if (c) return { role: joinRole(content, faction, rank, { age: who.age, occupation: who.occupation ?? null }), custom: true };
  }
  // 역할을 만드는 규칙이 없는 월드: 그 무리(없으면 아무)의 역할을 빌린다
  if (!c) return { role: roles.find((r) => r.faction === faction && r.rank === rank) ?? roles.find((r) => r.faction === faction) ?? roles[0]!, custom: false };
  const location = (who.zone && content.locations[who.zone] ? who.zone : null) ?? c.free_locations[0] ?? "";
  const role = buildCustomRole(content, {
    faction: null,
    rank: c.free_rank ?? rank,
    occupation: null,
    title: "떠돌이",
    location,
    kit: c.free_kit ?? c.kits[0]!.id,
    skills: {},
    age: who.age ?? 30,
    opening: `${content.locations[location]?.name ?? location}. 떠돌이로 오늘을 시작한다.`,
    background: [],
  });
  return { role: { ...role, start_inventory: [] }, custom: true };
}

/** 새 캐릭터 후보 id에서 세력·계급 */
export function parseNewAs(id: string): { faction: string; rank: string } | null {
  if (!id.startsWith(NEW_AS_PREFIX)) return null;
  const [faction, rank] = id.slice(NEW_AS_PREFIX.length).split(":");
  return faction && rank ? { faction: faction === NO_FACTION ? "" : faction, rank } : null;
}

export function successionOptions(state: GameState, content: Content): SuccessionOption[] {
  if (!state.characters[state.playerId]?.dead) return [];
  if (content.roles[state.scenarioRole]?.scenario?.heirs === false) return [];
  return heirCandidates(state, content);
}

function heirCandidates(state: GameState, content: Content): SuccessionOption[] {
  const options: SuccessionOption[] = [];
  // 새 캐릭터: 조우한 무리의 수색대원·분대장·간부 (역할을 만드는 규칙이 없는 월드면 그 무리에 있는 역할의 계급만)
  for (const f of encounteredFactions(state, content)) {
    const ranks = content.scenario.custom_start?.ranks ?? [...new Set(Object.values(content.roles).filter((r) => r.faction === f).map((r) => r.rank))];
    for (const rank of ranks) {
      // 그 자리가 빚을 지고 들어오는 자리면 미리 알린다 (12-239, 플레이 테스트 13: 새 호위대원에게 까닭 모를 빚 12)
      const debt = debtLine(content, heirSeat(content, f, rank, { age: null }).role);
      options.push({ id: `${NEW_AS_PREFIX}${f}:${rank}`, label: `새 캐릭터 (${content.factions[f]!.name} ${rankName(content, f, rank)})`, detail: `${content.factions[f]!.public}${debt ? ` ${debt}` : ""}` });
    }
  }
  // 떠돌이였던 주인공이 있으면 새 떠돌이로도 이어 갈 수 있다 (12-195)
  const freeRank = content.scenario.custom_start?.free_rank;
  if (freeRank && state.chronicle.some((r) => !r.factionId)) {
    options.push({ id: `${NEW_AS_PREFIX}${NO_FACTION}:${freeRank}`, label: `새 캐릭터 (${rankName(content, "", freeRank)})`, detail: "어느 무리에도 속하지 않고 담 밖에서 산다" });
  }
  // 조우한 사람: 이름을 아는, 살아 있고 플레이할 수 있는 인물. 무리의 우두머리(사다리 맨 위)는 맡을 자리가 없어 뺀다
  const top = content.scenario.rank_ladder.reduce((a, b) => (b.level > a.level ? b : a)).id;
  const met = encountered(state);
  const free = (c: GameState["characters"][string]) => !c.dead && !c.away && !heldOf(c) && c.rank !== top && met.has(c.id);
  const who = (c: GameState["characters"][string]) => `${c.factionId ? (content.factions[c.factionId]?.name ?? c.factionId) + " " : ""}${rankName(content, c.factionId, c.rank)}`;
  for (const npc of Object.values(content.npcs)) {
    const c = state.characters[npc.id];
    if (!c || !npc.playable || !free(c)) continue;
    options.push({ id: npc.id, label: `${npc.name} (${who(c)})`, detail: npc.reputation });
  }
  // 자란 인물 (기획서 7.10)
  for (const c of Object.values(state.characters)) {
    if (!c.profile || !free(c)) continue;
    options.push({ id: c.id, label: `${c.name} (${who(c)})`, detail: c.profile.reputation });
  }
  return options;
}


/**
 * 다음 캐릭터로 이어 간다. 새 캐릭터(new)는 캐릭터 생성에서 고른 것(character: 이름·성별·능력·트레잇·초상화)으로 만들 수 있다.
 * character가 없으면 예전처럼 역할의 기본으로 (name만 바꿀 수 있다)
 */
export function switchCharacter(
  ctx: ToolContext,
  choice: string,
  name: string | null,
  character?: CharacterChoice,
): { ok: true; text: string } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const options = successionOptions(state, content);
  if (storyEnded(state, content)) return { ok: false, error: storyEndedText(state, content) };
  if (options.length === 0) return { ok: false, error: "캐릭터가 살아 있다. 다음 캐릭터는 사망한 뒤에만 고른다." };
  if (!options.some((o) => o.id === choice)) {
    return { ok: false, error: `고를 수 없는 캐릭터: ${choice} (가능: ${options.map((o) => o.id).join(", ")})` };
  }
  const previous = state.characters[state.playerId]!;
  const newAs = parseNewAs(choice);

  if (newAs) {
    const id = `pc_${state.chronicle.length + 1}`;
    if (character) {
      const problems = checkCharacterChoice(content.scenario, character, { rank: newAs.rank, occupation: null, faction: newAs.faction || null });
      if (problems.length) return { ok: false, error: `캐릭터 설정이 규칙에 맞지 않는다: ${problems.join(" ")}` };
    }
    const seat = heirSeat(content, newAs.faction, newAs.rank, { age: character?.age ?? null });
    const role = seat.role;
    const made = createCharacterFromRole(content.scenario, role, id, ctx.rng, character ? fillCharacterChoice(content.scenario, character, ctx.rng) : undefined);
    if (!character && name?.trim()) {
      const problem = checkName(name);
      if (problem) return { ok: false, error: problem };
      made.name = name.trim();
    }
    // 두 번째 주인공부터는 시나리오 없이 세계만 이어 간다 (기획서 12.4.1)
    store.append({ type: "character_switched", characterId: id, character: made, known: [...role.known_npcs], roleId: role.id, ...(seat.custom ? { customRole: role } : {}), scenarioRole: "" });
    // 그 자리의 시작 지식은 이전 캐릭터의 기억이 아니라 그 자리에 오는 사람이면 아는 것이다
    const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
    for (const b of preset?.beliefs ?? []) {
      const s = store.getState();
      store.append({
        type: "belief_added",
        characterId: id,
        belief: { id: `b_${s.nextBeliefNo}`, fact: b.fact, source: b.source, accuracy: b.accuracy, learnedAt: s.time },
      });
    }
    // 설정의 뒷받침 (4.6.4): 지난 일·사물함·소중한 것
    applySettingBacking(ctx, { parts: true });
    if (made.past) {
      const s = store.getState();
      store.append({ type: "belief_added", characterId: id, belief: { id: `b_${s.nextBeliefNo}`, fact: `붕괴 전에 나는 ${josa(made.past.label, "이었다/였다")}. ${made.past.summary}.`, source: "seen", accuracy: "exact", learnedAt: START_TIME - 1 } });
    }
  } else {
    const successor = state.characters[choice]!;
    // 이어받는 사람의 무리·계급 자리 (무리가 없으면 떠돌이)
    // 죽는 자리에 함께 있었으면(장면·동행) 그 자리에서 이어 간다 (플레이 테스트 13: 곁에서 본 동행이 거점에서 시작해 "전해 들음"으로 알았다)
    const there = state.scene.present.includes(choice) || state.companions.includes(choice);
    const zone = there && state.playerZone ? state.playerZone : zoneOf(state, content, choice);
    const seat = heirSeat(content, successor.factionId, successor.rank, { age: successor.age, occupation: successor.occupation?.id ?? null, zone });
    // 같은 무리 사람들은 서로 안다
    const comrades = Object.values(state.characters)
      .filter((c) => c.id !== choice && c.id !== previous.id && content.npcs[c.id] && successor.factionId && c.factionId === successor.factionId)
      .map((c) => c.id);
    // 그 사람과 이어진 사람(가족·친구 등)도 안다 (B14, 플레이 테스트 9: 카드에 친구로 적힌 사람의 이름을 몰랐다)
    for (const t of tiesOf(state, content, choice)) if (t.other !== previous.id && state.characters[t.other] && !comrades.includes(t.other)) comrades.push(t.other);
    store.append({ type: "character_switched", characterId: choice, known: comrades, roleId: seat.role.id, ...(seat.custom ? { customRole: seat.role } : {}), scenarioRole: "" });
    // 그 사람이 있던 곳에서 이어 간다: 곁에 있었으면 그 자리, 아니면 그 사람이 지금 있을 자리(일과), 모르면 구역의 길 (공통 규칙 15 movePlayer, PT22 하얀매)
    const place = there ? currentPlace(state, content)?.id ?? null : (whereIs(state, content, choice)?.place ?? null);
    if (zone && content.locations[zone]) movePlayer(ctx, { zone, place: place ?? arrivalPlace(store.getState(), content, zone) }, "inherit");
  }

  // 이어받은 사람의 연인·배우자는 진짜 연인이다 (플레이 테스트 13)
  bindOwnLovers(ctx);
  // 이어받은 사람의 다짐도 바로 세운다 (첫 장면에 보이게)
  checkResolve(ctx);

  // 이전 캐릭터들의 죽음과 큰 행적은 소문으로 남는다 (기억은 넘어가지 않는다).
  // 바로 앞 캐릭터만이 아니라 최근 하루 안에 죽은 플레이어 캐릭터 모두. 그 사이에 여러 명이 죽었을 수 있다
  const now = store.getState();
  const heir = now.characters[now.playerId]!;
  const add = (fact: string, source: Belief["source"]) => {
    const s = store.getState();
    const text = sentence(fact);
    if ((s.beliefs[s.playerId] ?? []).some((b) => b.fact === text)) return;
    store.append({
      type: "belief_added",
      characterId: s.playerId,
      belief: { id: `b_${s.nextBeliefNo}`, fact: text, source, accuracy: "approximate", learnedAt: s.time },
    });
  };
  const recentDeaths = now.chronicle.filter((r, i) => i === now.chronicle.length - 1 || now.time - r.diedAt <= MINUTES_PER_DAY);
  for (const r of recentDeaths) {
    // 이어받는 사람이 부르는 말로. 같은 무리면 보고로, 아니면 소문으로 죽었다는 것만 (B14).
    // 사인은 그 자리를 본 사람(이어받는 사람이나 같은 무리)이 있을 때만 (플레이 테스트 12: 병원 지하에서 혼자 죽은 사인을 거점 사람이 바로 알았다)
    const report = !!heir.factionId && heir.factionId === r.factionId;
    const seen = r.characterId === previous.id && state.scene.present.some((id) => id !== previous.id && !state.characters[id]?.dead && (id === heir.id || (!!heir.factionId && state.characters[id]?.factionId === heir.factionId)));
    // 이어받는 사람이 그 자리에 있었으면 직접 본 일이다
    const witnessed = r.characterId === previous.id && (state.scene.present.includes(heir.id) || state.companions.includes(heir.id));
    // 공통 규칙 14: 그 자리에서 봤으면 직접, 같은 무리면 소식, 아니면 소문으로 (계승한 사람은 늘 듣는다)
    const fact = witnessed
      ? `${josa(r.name, "이/가")} 눈앞에서 죽었다 (${r.cause})`
      : `${josa(report ? r.name : nameAs(now, content, heir.id, r.characterId), "이/가")} ${report && seen ? `죽었다고 한다 (${r.cause})` : report ? "돌아오지 않았다. 죽었다고 한다 (어떻게 죽었는지 본 사람이 없다)" : "죽었다고 한다"}`;
    hearNews(ctx, { fact: sentence(fact), factions: [r.factionId], seen: witnessed, always: true, once: true });
  }
  // 같은 무리라면 지난 하루 우리 무리가 낀 교전은 보고로 들었다 (이전 캐릭터가 죽은 그 전투 포함)
  for (const { clash, at } of now.recentClashes) {
    if (now.time - at > MINUTES_PER_DAY) continue;
    if (clash.attacker !== heir.factionId && clash.defender !== heir.factionId) continue;
    // 이어받는 인물이 갇혀 있으면 닿지 않는다 (공통 규칙 14, 12-269)
    hearNews(ctx, { fact: describeClash(content, clash), factions: [clash.attacker, clash.defender], topic: WAR_TOPIC });
  }
  // 이전 캐릭터들의 행적: 이어받는 인물이 직접 보거나 들은 것은 언제 일이든 기억한다.
  // 아무것도 모르는 최근 사망자는 가장 큰 행적 하나가 소문으로 돈다
  const recentIds = new Set(recentDeaths.map((r) => r.characterId));
  for (const r of now.chronicle) {
    const knownDeeds = Object.values(now.deeds)
      .filter((d) => d.actorId === r.characterId && now.deedKnowledge[heir.id]?.[d.id])
      .sort((a, b) => a.at - b.at);
    if (knownDeeds.length > 0) {
      // 이어받는 인물이 그 사람의 이름을 몰랐으면 호칭으로 기억한다 (기획서 6.3)
      const who = nameAs(now, content, heir.id, r.characterId);
      for (const d of knownDeeds.slice(0, 3)) add(`${who}: ${d.summary}`, now.deedKnowledge[heir.id]![d.id]!);
    } else if (recentIds.has(r.characterId)) {
      const legend = Object.values(now.deeds)
        .filter((d) => d.actorId === r.characterId && d.severity >= 2)
        .sort((a, b) => b.severity - a.severity)[0];
      if (legend) add(`${heir.factionId && heir.factionId === r.factionId ? r.name : nameAs(now, content, heir.id, r.characterId)}에 대해 이런 말이 돈다: ${legend.summary}`, "rumor");
    }
  }

  // 유품 (12-158): 가까운 사람이 뒤를 이으면 사물함·거처의 짐을 물려받는다
  const inherited = inheritStashes(ctx, recentDeaths.map((r) => r.characterId));
  autoEquip(ctx, store.getState().playerId);
  const zoneNow = store.getState().playerZone;
  const place = zoneNow ? (content.locations[zoneNow]?.name ?? zoneNow) : null;
  const seatRole = content.roles[store.getState().roleId];
  const opening = newAs
    // 무소속이면 무리 문구가 아니다 (플레이 테스트 12: 떠돌이로 이어 갔는데 "이 무리에 들어와 맞는 첫날")
    ? (seatRole?.opening_scene ?? (heir.factionId ? `${place ? `${place}. ` : ""}${josa(heir.name, "이/가")} 이 무리에 들어와 맞는 첫날이다.` : `${place ? `${place}. ` : ""}떠돌이로 오늘을 시작한다.`))
    : `${place ? `${place}. ` : ""}${heir.name}의 하루가 시작된다. ${josa(previous.name, "이/가")} 죽은 뒤다.`;
  return {
    ok: true,
    text: [
      `이제 ${josa(heir.name, "으로/로")} 이어 간다. 새 캐릭터는 이전 캐릭터의 기억을 모른다. 이전 이야기를 이 캐릭터가 아는 것처럼 서술하지 마라.`,
      `시작 장면: ${opening}`,
      ...(newAs && debtLine(content, seatRole) ? [debtLine(content, seatRole)!] : []),
      ...inherited,
    ].join("\n"),
  };
}

/** 이어 갈 수 없는 시나리오가 끝났을 때 GM에게 */
export const STORY_ENDED =
  "이 판은 주인공의 죽음으로 끝났다 (이 시나리오는 다음 캐릭터로 이어 갈 수 없거나, 이어 갈 만한 사람을 만나지 못했다). 플레이어에게 그렇게 알리고, 새 게임에서 열린 시나리오를 고를 수 있다고 안내한 뒤 end_session으로 닫는다.";

/** 이어 갈 수 없는 까닭을 나눠 말한다 (플레이 테스트 11: 튜토리얼인데 "만나지 못했다"고 했다) */
export function storyEndedText(state: GameState, content: Content): string {
  const why = content.roles[state.scenarioRole]?.scenario?.heirs === false ? "이 시나리오는 다음 캐릭터로 이어 가지 않는다" : "이어 갈 만한 사람을 만나지 못했다";
  return `이 판은 주인공의 죽음으로 끝났다 (${why}). 플레이어에게 그렇게 알리고, 새 게임에서 열린 시나리오를 고를 수 있다고 안내한 뒤 end_session으로 닫는다.`;
}

export const writeEpitaph = defineTool({
  name: "write_epitaph",
  description:
    "캐릭터가 사망한 뒤, 연대기에 남길 짧은 회고(묘비명)를 쓴다. 한두 문장. 기록(생존 일수, 행적, 사망 원인)에 없는 사실을 지어내지 않는다. 한 번만 쓸 수 있다.",
  schema: z.strictObject({ text: z.string().min(1).max(300).describe("묘비명 한두 문장") }),
  run(input, ctx) {
    const state = ctx.store.getState();
    const index = state.chronicle.length - 1;
    const record = state.chronicle[index];
    if (!record || !state.characters[state.playerId]?.dead || record.characterId !== state.playerId) {
      return { ok: false, error: "묘비명은 캐릭터가 막 사망했을 때만 쓴다." };
    }
    if (record.epitaph) return { ok: false, error: "이미 묘비명이 있다." };
    ctx.store.append({ type: "epitaph_written", index, text: input.text.trim() });
    return {
      ok: true,
      resultText: storyEnded(ctx.store.getState(), ctx.content)
        ? `묘비명을 남겼다. 연대기를 플레이어에게 보여 준다 (get_chronicle). ${storyEndedText(ctx.store.getState(), ctx.content)}`
        : "묘비명을 남겼다. 연대기와 다음 캐릭터 후보를 플레이어에게 보여 준다 (get_chronicle).",
      display: { type: "epitaph", name: record.name, text: input.text.trim() },
    };
  },
});

export const SUCCESSION_TOOLS = [writeEpitaph] as const;

/** 연대기 텍스트 (!연대기, get_chronicle). 플레이어(사람)를 위한 기록이다 */
export function formatChronicle(state: GameState, content: Content): string[] {
  if (state.chronicle.length === 0) return ["아직 죽은 캐릭터가 없습니다."];
  const lines: string[] = [];
  state.chronicle.forEach((r, i) => {
    const faction = content.factions[r.factionId]?.name ?? r.factionId;
    lines.push(
      `${i + 1}. ${r.name} · ${faction} ${rankName(content, r.factionId, r.rank)} · ${daysSurvived(r)}일 생존 · 공적 ${r.merit}`,
      `   ${formatTime(r.startedAt)} ~ ${formatTime(r.diedAt)} · 사망: ${r.cause}`,
      ...r.deeds.map((d) => `   - ${d}`),
      ...resolveChronicle(state, content, r.characterId).map((d) => `   · ${d}`),
      ...(r.epitaph ? [`   "${r.epitaph}"`] : []),
      "",
    );
  });
  return lines;
}
