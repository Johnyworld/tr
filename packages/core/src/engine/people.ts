import { maskUnknownNames } from "./storyletTools.ts";
import { onLoverDeath } from "./romance.ts";
import { createExtraCharacter } from "./extras.ts";
import { isInfected, templateKind } from "../game/kinds.ts";
import { frighten } from "./fear.ts";
import { shakeNerves } from "./body.ts";
import { z } from "zod";
import type { Content, NpcContent } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { bondOf } from "../game/companions.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import type { Character } from "../game/character.ts";
import { FAMILY_KINDS, TIE_INVERSE, TIE_LABELS, tieKey, tieKnown, tiesOf, type TieKind, type TieRecord } from "../game/ties.ts";
import type { Rng } from "../rng.ts";
import { josa } from "../text.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 인물 사이의 관계와 자라는 인물 (기획서 7.10).
 * - 관계: 정해진 것(콘텐츠) + 동적인 것(세계를 만들 때, 인물이 자랄 때). 숨은 관계는 신뢰가 쌓여야 털어놓는다
 * - 자라기: 이름 없는 인물이 주인공과 깊이 엮이면 틀의 재료로 프로필이 생긴다 (재료는 콘텐츠, 고르는 것은 코드)
 */

/** 관계(신뢰·호감·존중 절댓값의 합)가 이만큼이면 자란다 */
const PROMOTE_AT = 4;
/** 동적인 숨은 관계의 털어놓는 조건 */
const DYNAMIC_SECRET = { reveal_when: "둘만 있을 때, 그 사람 이야기가 나오면", min_trust: 2 };

type Profile = { want: string; fear: string; reputation: string; voice: { style: string; samples: string[] }; rules: string[]; secret: { content: string; reveal_when: string; min_trust: number } | null };

/** 이름 있는 인물의 프로필 (콘텐츠 NPC 또는 자란 인물). 없으면 null */
export function profileOf(state: GameState, content: Content, id: string): Profile | null {
  const npc = content.npcs[id];
  if (npc) return { want: npc.want, fear: npc.fear, reputation: npc.reputation, voice: npc.voice, rules: npc.rules, secret: npc.secret ?? null };
  return state.characters[id]?.profile ?? null;
}

const pickFrom = <T,>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const ageOf = (state: GameState, content: Content, id: string) => state.characters[id]?.age ?? content.npcs[id]?.age ?? null;

/** a가 b의 kind가 될 수 있는 나이인가 */
function agesFit(kind: TieKind, a: number | null, b: number | null): boolean {
  if (a === null || b === null) return kind === "friend" || kind === "rival";
  if (kind === "parent") return a - b >= 17;
  if (kind === "child") return b - a >= 17;
  if (kind === "sibling") return Math.abs(a - b) <= 15;
  if (kind === "spouse") return a >= 20 && b >= 20 && Math.abs(a - b) <= 15;
  return true;
}

/** 관계를 이을 수 있는 이름 있는 인물 (지도부가 아니고, 살아 있고, 이미 이어진 사이가 아닌) */
function tieable(state: GameState, content: Content, exclude: Set<string>): NpcContent[] {
  return Object.values(content.npcs)
    .filter((n) => !exclude.has(n.id) && n.id !== state.playerId && n.rank !== "leader")
    .filter((n) => !state.characters[n.id]?.dead && !state.characters[n.id]?.away)
    .sort((x, y) => x.id.localeCompare(y.id));
}

/** 세계를 만들 때 이름 있는 인물들을 무작위로 잇는다 (정해진 관계가 없는 사람끼리). 무리가 다르면 숨은 관계 */
export function generateDynamicTies(ctx: ToolContext): void {
  const { store, content, rng } = ctx;
  const rule = content.scenario.dynamic_ties;
  if (!rule || rule.count <= 0) return;
  const state = store.getState();
  const authored = new Set<string>();
  for (const n of Object.values(content.npcs)) {
    if ((n.ties ?? []).length) authored.add(n.id);
    for (const t of n.ties ?? []) authored.add(t.to);
  }
  const used = new Set<string>(authored);
  const ties: TieRecord[] = [];
  for (let i = 0; i < rule.count * 4 && ties.length < rule.count; i++) {
    const pool = tieable(state, content, used);
    if (pool.length < 2) break;
    const a = pickFrom(rng, pool);
    const kind = pickFrom(rng, rule.kinds) as TieKind;
    const partners = pool.filter((b) => b.id !== a.id && agesFit(kind, a.age, b.age));
    if (!partners.length) continue;
    const b = pickFrom(rng, partners);
    ties.push({ a: a.id, b: b.id, kind, secret: a.faction !== b.faction ? DYNAMIC_SECRET : null });
    used.add(a.id);
    used.add(b.id);
  }
  if (ties.length) store.append({ type: "ties_generated", ties });
}

/** 이름 없는 인물을 자라게 한다: 틀의 재료로 프로필, 틀의 확률로 이름 있는 인물과의 관계 */
export function promoteExtra(ctx: ToolContext, id: string): boolean {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const c = state.characters[id];
  const template = c?.extra ? content.extras[c.extra.template] : undefined;
  if (!c || c.dead || c.profile || !template?.profile || templateKind(template) !== "person") return false;
  const p = template.profile;
  const secret = p.secrets.length && rng() < 0.6 ? pickFrom(rng, p.secrets) : null;
  const profile = {
    want: pickFrom(rng, p.wants),
    fear: pickFrom(rng, p.fears),
    reputation: pickFrom(rng, p.reputations),
    voice: pickFrom(rng, p.voices),
    rules: p.rules.length ? [pickFrom(rng, p.rules)] : [],
    secret: secret ? { ...secret } : null,
    promotedAt: state.time,
  };
  const ties: TieRecord[] = [];
  if (template.ties && rng() < template.ties.chance) {
    const kind = pickFrom(rng, template.ties.kinds) as TieKind;
    const others = tieable(state, content, new Set()).filter((n) => agesFit(kind, c.age, n.age));
    if (others.length) {
      const other = pickFrom(rng, others);
      // 무리가 다르거나 떠돌이면 숨은 관계 (누구의 가족인지는 쉽게 말하지 않는다)
      ties.push({ a: id, b: other.id, kind, secret: c.factionId !== other.faction ? DYNAMIC_SECRET : null });
    }
  }
  store.append({ type: "extra_promoted", characterId: id, profile, ties });
  return true;
}

/** 시간이 흐른 뒤: 깊이 엮인 이름 없는 인물이 자란다 */
export function runPromotions(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const out: ToolDisplayEvent[] = [];
  const state = store.getState();
  for (const c of Object.values(state.characters)) {
    if (!c.extra || c.profile || c.dead || c.id === state.playerId) continue;
    const r = state.relations[c.id]?.[state.playerId] ?? NEUTRAL_RELATION;
    const bond = bondOf(state, content, c.id);
    const deep = Math.abs(r.trust) + Math.abs(r.affection) + Math.abs(r.respect) >= PROMOTE_AT || bond?.kind === "kin" || bond?.kind === "purpose";
    if (!deep || !promoteExtra(ctx, c.id)) continue;
    const name = playerCalls(store.getState(), content, c.id);
    out.push({ type: "presence", npcName: name, action: "enter", note: `${josa(name, "은/는")} 이제 그냥 스쳐 가는 사람이 아니다. 그 인물의 카드에 원하는 것·말투·규칙이 생겼다. 다음 장면부터 그대로 연기한다.` });
  }
  return out;
}

/** 이름 있는 인물이 죽으면 가족·친구가 듣는다. 주인공이 죽였고 그 자리에 있었다면 주인공을 미워한다 */
export function onPersonDeath(ctx: ToolContext, id: string, by: string): void {
  const { store, content } = ctx;
  const state = store.getState();
  if (id === state.playerId) return;
  const dead = playerCalls(state, content, id);
  // 연인을 잃으면 마음이 무너진다 (12-58)
  onLoverDeath(ctx, id);
  // 곁에서 죽는 것을 보면 마음이 흔들린다 (12-48)
  const nerves = content.scenario.body?.nerves;
  if (nerves && (state.scene.present.includes(id) || state.companions.includes(id)) && !isInfected(content, state.characters[id])) {
    shakeNerves(ctx, nerves.witness_death, `${josa(dead, "이/가")} 눈앞에서 죽었다`);
  }
  // 눈앞의 죽음은 공포도 부른다 (12-95)
  const fear = content.scenario.body?.fear;
  if (fear && (state.scene.present.includes(id) || state.companions.includes(id)) && !isInfected(content, state.characters[id])) {
    frighten(ctx, fear.witness_death, `${josa(dead, "이/가")} 눈앞에서 죽었다`);
  }
  // 그 자리에 있던 다른 사람 (주인공·죽은 사람 빼고): 누가 죽였는지 말이 퍼진다
  const witnesses = state.scene.present.filter((w) => w !== id && w !== state.playerId && !state.characters[w]?.dead);
  for (const t of tiesOf(state, content, id)) {
    if (t.kind === "rival") continue;
    const kin = state.characters[t.other];
    if (!kin || kin.dead || t.other === state.playerId) continue;
    const s = store.getState();
    store.append({
      type: "belief_added",
      characterId: t.other,
      belief: { id: `b_${s.nextBeliefNo}`, fact: `${dead}(내 ${TIE_LABELS[TIE_INVERSE[t.kind]]})이 죽었다`, source: "report", accuracy: "exact", learnedAt: s.time },
    });
    if (by !== "attack") continue;
    const family = FAMILY_KINDS.includes(t.kind);
    // 누가 죽였는지 안다: 그 자리에 있었거나, 다른 목격자가 있어 말이 퍼졌거나, 흔적으로 (12-135)
    const present = state.scene.present.includes(t.other);
    const learned = present || witnesses.length > 0 || ctx.rng() < VENDETTA_TRACE_CHANCE;
    if (!learned) continue;
    store.append({ type: "relation_changed", from: t.other, to: state.playerId, delta: { trust: -3, affection: family ? -3 : -2, respect: 0 }, reason: present ? `${josa(dead, "을/를")} 눈앞에서 죽였다` : `${josa(dead, "을/를")} 죽였다고 들었다` });
    // 가족·연인·친구는 복수를 다짐한다
    if (family || t.kind === "lover" || t.kind === "friend") store.append({ type: "vendetta_sworn", avenger: t.other, victim: id });
  }
  // 복수할 사람이 아무도 나서지 않았으면, 세상 어딘가의 그 사람의 가족·친구가 (12-135)
  if (by === "attack" && !store.getState().vendettas.some((v) => v.victim === id)) spawnAvenger(ctx, id, witnesses.length > 0);
  if (by === "attack") noteKillForBounty(ctx, id, witnesses.length > 0);
}

/** 그 무리가 주인공이 자기 사람을 이만큼 죽인 것을 알면 현상금을 건다 (12-136, *임시*) */
export const BOUNTY_AT = 3;

/** 주인공이 다른 무리 사람을 죽였고 그 무리가 알게 되면(목격자, 흔적) 센다. BOUNTY_AT에 이르면 현상금 */
function noteKillForBounty(ctx: ToolContext, deadId: string, witnessed: boolean): void {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const dead = state.characters[deadId];
  const me = state.characters[state.playerId];
  if (!dead || !me || isInfected(content, dead) || dead.extra?.turnedFrom) return;
  if (dead.extra && templateKind(content.extras[dead.extra.template]) !== "person") return;
  const faction = dead.factionId;
  if (!faction || faction === me.factionId || !state.factions[faction]) return;
  if (!witnessed && rng() >= VENDETTA_TRACE_CHANCE) return;
  store.append({ type: "kill_known", factionId: faction });
  const now = store.getState();
  if ((now.killsKnown[faction] ?? 0) < BOUNTY_AT || now.bounties.includes(faction)) return;
  store.append({ type: "bounty_posted", factionId: faction });
  const fact = `${josa(content.factions[faction]?.name ?? faction, "이/가")} 내 머리에 값을 걸었다는 소문이 돈다`;
  store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact, source: "rumor", accuracy: "approximate", learnedAt: now.time } });
}

/** 목격자 없이 죽였어도 가족·친구가 흔적으로 누가 죽였는지 알게 될 확률 (12-135, *임시*) */
export const VENDETTA_TRACE_CHANCE = 0.3;
/** 이름 없는 사람을 죽였을 때 그 사람의 가족·친구가 복수하러 나설 확률: 목격자가 있으면 / 없으면 (12-135, *임시*) */
export const EXTRA_AVENGER_CHANCE = { witnessed: 0.25, unseen: 0.1 };
/** 한꺼번에 복수를 다짐한 사람의 상한 (넘으면 새로 만들지 않는다) */
export const MAX_VENDETTAS = 3;

/** 복수자가 그 사람에게 무엇인지와 나이 차 (복수자 나이 = 죽은 사람 나이 + 차) */
const AVENGER_KINDS: { kind: TieKind; gap: [number, number] }[] = [
  { kind: "sibling", gap: [-6, 6] },
  { kind: "parent", gap: [20, 30] },
  { kind: "child", gap: [-28, -18] },
  { kind: "spouse", gap: [-4, 4] },
  { kind: "friend", gap: [-5, 5] },
];

/** 복수자를 만들 틀: 죽은 사람이 엑스트라면 그 틀, 아니면 같은 무리의 사람 틀 (무리가 없으면 무리 없는 사람 틀). 자랄 재료가 있어야 한다 */
function avengerTemplate(content: Content, dead: Character) {
  const own = dead.extra ? content.extras[dead.extra.template] : undefined;
  if (own?.profile && templateKind(own) === "person") return own;
  const people = Object.values(content.extras).filter((t) => t.profile && templateKind(t) === "person" && t.appears?.zones?.length !== 0);
  const faction = dead.factionId || null;
  return people.find((t) => (t.faction ?? null) === faction) ?? people.find((t) => !t.faction);
}

/**
 * 주인공이 죽인 사람에게 복수할 가족·친구가 아무도 없을 때 (12-135): 확률로 엑스트라 가족·친구를 만들어 복수를 다짐하게 한다.
 * 이름 없는 사람이든 이름 있는 인물이든 (정해진 인물의 가족이 엑스트라일 수도 있다).
 * 사람 틀로 만들어 바로 자라게 하고(이름·원하는 것·말투), 죽은 사람과 잇고, 그 무리의 땅에 둔다.
 * 장면에 들이지 않고 만난 것으로도 치지 않는다 (이야기로만 나타난다)
 */
function spawnAvenger(ctx: ToolContext, deadId: string, witnessed: boolean): void {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const dead = state.characters[deadId];
  if (!dead || dead.extra?.turnedFrom || isInfected(content, dead)) return;
  if (dead.extra && templateKind(content.extras[dead.extra.template]) !== "person") return;
  const template = avengerTemplate(content, dead);
  if (!template) return;
  if ((state.vendettas ?? []).length >= MAX_VENDETTAS) return;
  if (rng() >= (witnessed ? EXTRA_AVENGER_CHANCE.witnessed : EXTRA_AVENGER_CHANCE.unseen)) return;
  const base = dead.age ?? 30;
  const options = AVENGER_KINDS.filter((k) => base + k.gap[0] >= 16 && base + k.gap[1] <= 75);
  const pick = options[Math.floor(rng() * options.length)];
  if (!pick) return;
  const age = Math.max(16, base + pick.gap[0] + Math.floor(rng() * (pick.gap[1] - pick.gap[0] + 1)));
  const home = Object.values(content.locations).find((l) => l.kind === "base" && l.owner === dead.factionId)?.id ?? dead.extra?.zone ?? state.playerZone;
  const id = `ex_${state.nextExtraNo}`;
  const usedNames = new Set(Object.values(state.characters).map((c) => c.name));
  const avenger = createExtraCharacter(content, template, { id, label: template.label, zone: home ?? null, time: state.time, usedNames }, rng);
  avenger.age = age;
  store.append({ type: "extra_spawned", character: avenger, unseen: true });
  promoteExtra(ctx, id);
  store.append({ type: "ties_generated", ties: [{ a: id, b: deadId, kind: pick.kind, secret: null }] });
  store.append({ type: "relation_changed", from: id, to: state.playerId, delta: { trust: -3, affection: -3, respect: 0 }, reason: `${josa(TIE_LABELS[TIE_INVERSE[pick.kind]], "을/를")} 죽였다` });
  store.append({ type: "vendetta_sworn", avenger: id, victim: deadId });
}

/** 카드에 붙일 관계 줄: 아는 관계, 털어놓을 수 있는 숨은 관계 */
export function describeTieLines(state: GameState, content: Content, id: string): string[] {
  const lines: string[] = [];
  const trust = (state.relations[id]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
  for (const t of tiesOf(state, content, id)) {
    const other = state.characters[t.other];
    if (!other) continue;
    const who = t.other === state.playerId ? "당신" : `${playerCalls(state, content, t.other)}(${t.other})`;
    const where = other.factionId && other.factionId !== state.characters[id]?.factionId ? ` · ${content.factions[other.factionId]?.name ?? other.factionId}` : "";
    const fate = other.dead ? " · 죽었다" : other.captive ? " · 붙잡혀 있다" : other.away ? " · 떠났다" : "";
    if (tieKnown(state, t)) lines.push(`관계: ${who}의 ${TIE_LABELS[t.kind]}${where}${fate}`);
    else if (t.secret && trust >= t.secret.min_trust) {
      lines.push(`털어놓을 수 있는 숨은 관계: ${who}의 ${TIE_LABELS[t.kind]}${where}${fate} (공개 상황: ${maskUnknownNames(state, content, t.secret.reveal_when)}). 상황이 맞으면 reveal_tie`);
    }
  }
  // 복수 다짐 (12-135): GM이 연기하는 그 인물의 속마음. 주인공에게 드러내는지는 장면이 정한다
  const v = (state.vendettas ?? []).find((x) => x.avenger === id);
  if (v) lines.push(`원한: 당신이 ${josa(playerCalls(state, content, v.victim), "을/를")} 죽인 것을 알고 복수를 다짐했다. 겉으로 드러낼지, 기회를 노릴지는 그 사람의 성격대로`);
  return lines;
}

const promoteTool = defineTool({
  name: "promote_extra",
  description:
    "이름 없는 인물을 이야기에 붙잡아 이름 있는 인물로 자라게 한다 (기획서 7.10). 장면에 있고 주인공과 엮인 인물만. " +
    "원하는 것·말투·비밀·관계는 시스템이 틀의 재료에서 정한다 (지어내지 않는다). 지나가는 사람에게는 쓰지 않는다.",
  schema: z.strictObject({ target: z.string().describe("장면에 있는 이름 없는 인물 id") }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const c = state.characters[input.target];
    if (!c?.extra || !state.scene.present.includes(input.target)) return { ok: false, error: "장면에 있는 이름 없는 인물이 아니다." };
    if (c.profile) return { ok: false, error: "이미 자란 인물이다." };
    const template = content.extras[c.extra.template];
    if (template?.kind === "animal") return { ok: false, error: "동물은 자라지 않는다 (이미 동행이면 충분하다)." };
    if (template?.kind === "infected") return { ok: false, error: "감염체는 자라지 않는다." };
    if (!template?.profile) return { ok: false, error: `이 틀(${template?.label ?? c.extra.template})은 자랄 재료가 없다.` };
    promoteExtra(ctx, input.target);
    const p = store.getState().characters[input.target]!.profile!;
    const name = playerCalls(store.getState(), content, input.target);
    return {
      ok: true,
      resultText: `${josa(name, "은/는")} 이제 이야기 속 인물이다. 원하는 것: ${p.want} / 두려워하는 것: ${p.fear} / 말투: ${p.voice.style}. 카드에 붙은 대로 연기한다 (서술로 직접 밝히지 않는다).`,
      display: { type: "presence", npcName: name, action: "enter" },
    };
  },
});

const revealTie = defineTool({
  name: "reveal_tie",
  description:
    "장면의 인물이 숨은 관계(상태의 '털어놓을 수 있는 숨은 관계')를 털어놓는다. 상황이 맞을 때만. 관계의 내용은 시스템이 결과로 알려 준다.",
  schema: z.strictObject({ npc_id: z.string(), other: z.string().describe("관계의 상대 id") }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    if (!state.scene.present.includes(input.npc_id)) return { ok: false, error: "장면에 없는 인물이다." };
    const tie = tiesOf(state, content, input.npc_id).find((t) => t.other === input.other);
    if (!tie?.secret || tieKnown(state, tie)) return { ok: false, error: "털어놓을 숨은 관계가 아니다." };
    const trust = (state.relations[input.npc_id]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
    const name = playerCalls(state, content, input.npc_id);
    if (trust < tie.secret.min_trust) return { ok: false, error: `${josa(name, "은/는")} 아직 그만큼 당신을 믿지 않는다.` };
    store.append({ type: "tie_revealed", key: tie.key });
    const other = state.characters[input.other];
    const otherName = other ? `${other.name}` : input.other;
    const where = other?.factionId ? ` (${content.factions[other.factionId]?.name ?? other.factionId})` : "";
    const fact = `${name}의 고백: 나는 ${otherName}${where}의 ${TIE_LABELS[tie.kind]}다`;
    const s = store.getState();
    store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${s.nextBeliefNo}`, fact, source: "report", accuracy: "exact", learnedAt: s.time } });
    // 털어놓으면 상대의 이름도 알게 된다
    if (other && !(state.known[state.playerId] ?? []).includes(input.other)) store.append({ type: "name_learned", characterId: state.playerId, targetId: input.other });
    return { ok: true, resultText: `${josa(name, "이/가")} 털어놓는다: ${otherName}${where}의 ${TIE_LABELS[tie.kind]}다.\n망설임과 감정을 담아 서술한다.`, display: { type: "belief", fact, sourceLabel: "고백" } };
  },
});

export const PEOPLE_TOOLS = [promoteTool, revealTie] as const;

/** 자란 인물의 연기 카드 몸통 (이름 있는 인물의 카드와 같은 모양) */
export function describeProfileLines(state: GameState, content: Content, c: Character): string[] {
  const p = c.profile;
  if (!p) return [];
  const trust = (state.relations[c.id]?.[state.playerId] ?? NEUTRAL_RELATION).trust;
  const secret = !p.secret
    ? null
    : state.revealedSecrets.includes(c.id)
      ? `당신에게 털어놓은 비밀: ${p.secret.content}`
      : trust >= p.secret.min_trust
        ? `이 인물은 이제 당신에게 비밀을 털어놓을 수 있는 관계다. 공개 상황: ${maskUnknownNames(state, content, p.secret.reveal_when)}. 상황이 맞으면 reveal_secret`
        : null;
  return [
    `말투: ${p.voice.style} / 예시 대사: ${p.voice.samples.map((x) => `"${x}"`).join(" / ")}`,
    `평판: ${p.reputation}`,
    `[GM 전용: 연기에만 쓰고 서술로 직접 드러내지 않는다] 원하는 것: ${maskUnknownNames(state, content, p.want)} / 두려워하는 것: ${maskUnknownNames(state, content, p.fear)}`,
    ...(p.rules.length ? [`행동 규칙: ${p.rules.map((r) => maskUnknownNames(state, content, r)).join(" / ")}`] : []),
    ...(secret ? [secret] : []),
  ];
}
