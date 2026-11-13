import { addStartCompanions } from "./companionTools.ts";
import { z } from "zod";
import { nameAs } from "../game/acquaintance.ts";
import { checkCharacterChoice, fillCharacterChoice } from "../game/creation.ts";
import type { CharacterChoice } from "../game/state.ts";
import type { Content } from "../content/schemas.ts";
import type { Belief } from "../game/belief.ts";
import { createCharacterFromRole, type GameState, type RunRecord } from "../game/state.ts";
import { formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import { rankLabel } from "../scenario/scenario.ts";
import { josa, sentence } from "../text.ts";
import { defineTool, type ToolContext } from "./toolkit.ts";
import { describeClash, WAR_TOPIC } from "./warTools.ts";

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
 * 다음 캐릭터 후보. 플레이어가 죽었을 때만 있다.
 * - new: 시작 역할로 새로 만든 캐릭터
 * - 이전 캐릭터가 알던, 살아 있고 플레이할 수 있는 NPC
 */
/** 해금된 다른 시나리오로 새 캐릭터를 만들 때의 후보 id 머리 (new:<역할 id>) */
export const NEW_AS_PREFIX = "new:";

export function successionOptions(state: GameState, content: Content): SuccessionOption[] {
  const dead = state.characters[state.playerId];
  if (!dead?.dead) return [];
  const role = content.roles[state.roleId];
  const options: SuccessionOption[] = [];
  if (role) options.push({ id: "new", label: `새 캐릭터 (${role.label})`, detail: "이 세계에 막 들어온 사람. 아무도 모른다." });
  // 해금된 다른 시나리오로 새로 시작할 수도 있다 (기획서 9.12)
  for (const r of Object.values(content.roles)) {
    if (!r.unlock || !state.unlocked.includes(r.unlock) || r.id === state.roleId) continue;
    options.push({ id: `${NEW_AS_PREFIX}${r.id}`, label: `새 캐릭터 (${r.label})`, detail: r.scenario?.pitch ?? "해금된 시나리오" });
  }
  const known = new Set(state.known[state.playerId] ?? []);
  for (const npc of Object.values(content.npcs)) {
    const c = state.characters[npc.id];
    // MVP: 역할 규칙(상관, 임무, 이야기)이 시작 역할의 것이라 같은 무리 사람으로만 이어 간다
    if (!c || c.dead || c.away || c.captive || !npc.playable || !known.has(npc.id) || c.factionId !== dead.factionId) continue;
    options.push({
      id: npc.id,
      label: `${npc.name} (${content.factions[c.factionId]?.name ?? c.factionId} ${rankLabel(content.scenario, c.rank)})`,
      detail: npc.reputation,
    });
  }
  // 자란 인물도 같은 무리면 이어 갈 수 있다 (기획서 7.10)
  for (const c of Object.values(state.characters)) {
    if (!c.profile || c.dead || c.away || c.captive || !known.has(c.id) || c.factionId !== dead.factionId) continue;
    options.push({ id: c.id, label: `${c.name} (${c.factionId ? (content.factions[c.factionId]?.name ?? c.factionId) + " " : ""}${rankLabel(content.scenario, c.rank)})`, detail: c.profile.reputation });
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
  if (options.length === 0) return { ok: false, error: "캐릭터가 살아 있다. 다음 캐릭터는 사망한 뒤에만 고른다." };
  if (!options.some((o) => o.id === choice)) {
    return { ok: false, error: `고를 수 없는 캐릭터: ${choice} (가능: ${options.map((o) => o.id).join(", ")})` };
  }
  const previous = state.characters[state.playerId]!;
  const switchedRole = choice.startsWith(NEW_AS_PREFIX) ? choice.slice(NEW_AS_PREFIX.length) : null;
  const role = content.roles[switchedRole ?? state.roleId]!;

  if (choice === "new" || switchedRole) {
    const id = `pc_${state.chronicle.length + 1}`;
    if (character) {
      const problems = checkCharacterChoice(content.scenario, character);
      if (problems.length) return { ok: false, error: `캐릭터 설정이 규칙에 맞지 않는다: ${problems.join(" ")}` };
    }
    const made = createCharacterFromRole(content.scenario, role, id, ctx.rng, character ? fillCharacterChoice(content.scenario, character, ctx.rng) : undefined);
    if (!character && name?.trim()) made.name = name.trim().slice(0, 20);
    store.append({ type: "character_switched", characterId: id, character: made, known: [...role.known_npcs], ...(switchedRole ? { roleId: switchedRole } : {}) });
    // 그 자리에 오는 사람의 동행 (역할의 시작 동행)
    addStartCompanions(ctx, role);
    // 역할의 시작 지식은 이전 캐릭터의 기억이 아니라 그 자리에 오는 사람이면 아는 것이다
    const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
    for (const b of preset?.beliefs ?? []) {
      const s = store.getState();
      store.append({
        type: "belief_added",
        characterId: id,
        belief: { id: `b_${s.nextBeliefNo}`, fact: b.fact, source: b.source, accuracy: b.accuracy, learnedAt: s.time },
      });
    }
  } else {
    const successor = state.characters[choice]!;
    // 같은 무리 사람들은 서로 안다
    const comrades = Object.values(state.characters)
      .filter((c) => c.id !== choice && c.id !== previous.id && content.npcs[c.id] && c.factionId === successor.factionId)
      .map((c) => c.id);
    store.append({ type: "character_switched", characterId: choice, known: comrades });
  }

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
    add(`${josa(r.name, "이/가")} 죽었다고 한다 (${r.cause})`, heir.factionId === r.factionId ? "report" : "rumor");
  }
  // 같은 무리라면 지난 하루 우리 무리가 낀 교전은 보고로 들었다 (이전 캐릭터가 죽은 그 전투 포함)
  for (const { clash, at } of now.recentClashes) {
    if (now.time - at > MINUTES_PER_DAY) continue;
    if (clash.attacker !== heir.factionId && clash.defender !== heir.factionId) continue;
    const s = store.getState();
    store.append({
      type: "belief_added",
      characterId: s.playerId,
      belief: { id: `b_${s.nextBeliefNo}`, fact: describeClash(content, clash), source: "report", accuracy: "approximate", learnedAt: s.time, topic: WAR_TOPIC },
    });
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
      if (legend) add(`${r.name}에 대해 이런 말이 돈다: ${legend.summary}`, "rumor");
    }
  }

  const opening =
    choice === "new" || switchedRole
      ? role.opening_scene
      : `${heir.name}의 하루가 시작된다. ${josa(previous.name, "이/가")} 죽은 뒤의 거점이다.`;
  return {
    ok: true,
    text: [
      `이제 ${josa(heir.name, "으로/로")} 이어 간다. 새 캐릭터는 이전 캐릭터의 기억을 모른다. 이전 이야기를 이 캐릭터가 아는 것처럼 서술하지 마라.`,
      `시작 장면: ${opening}`,
    ].join("\n"),
  };
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
      resultText: "묘비명을 남겼다. 연대기와 다음 캐릭터 후보를 플레이어에게 보여 준다 (get_chronicle).",
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
      `${i + 1}. ${r.name} · ${faction} ${rankLabel(content.scenario, r.rank)} · ${daysSurvived(r)}일 생존 · 공적 ${r.merit}`,
      `   ${formatTime(r.startedAt)} ~ ${formatTime(r.diedAt)} · 사망: ${r.cause}`,
      ...r.deeds.map((d) => `   - ${d}`),
      ...(r.epitaph ? [`   "${r.epitaph}"`] : []),
      "",
    );
  });
  return lines;
}
