import { weatherNow } from "../sim/weather.ts";
import { describeExtraTemplates } from "./extras.ts";
import { aliasOf, hasMet, headingAs, knowsName } from "../game/acquaintance.ts";
import { isIncapacitated } from "./body.ts";
import { attractionOf, looksOf, oppositeSex, sameSex, traitLabels } from "./traits.ts";
import { DIFFICULTY_MODIFIER } from "../rules/check.ts";
import {
  conditionPenalty,
  describeConditions,
  initialConditions,
  rankLabel,
  speechLevel,
} from "../scenario/scenario.ts";
import { formatTime } from "../rules/time.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Character, Inventory } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import type { Content, NpcContent } from "../content/schemas.ts";
import { describeMissionsForGm } from "./missionTools.ts";
import { describeFactionsForGm } from "./warTools.ts";
import { describeBattleForGm } from "./battleTools.ts";
import { describeStoryletForGm } from "./storyletTools.ts";
import { BELIEF_SOURCE_LABELS as SOURCE_LABELS } from "../game/belief.ts";
import { NEUTRAL_RELATION, RELATION_AXES, RELATION_AXIS_LABELS, relationLabel } from "../game/reputation.ts";

/**
 * 정보 필터 (기획서 6.2).
 * GM 프롬프트에는 현재 캐릭터의 Belief State와 그 캐릭터가 볼 수 있는 것만 넣는다 (CLAUDE.md 원칙 4).
 * - 플레이어의 믿음은 출처와 함께 넣고, 진짜 정확도(accuracy)는 넣지 않는다
 * - 장면에 있는 NPC는 연기에 필요한 프로필을 넣되, 비밀(secret)과 모르는 것(doesnt_know)은 넣지 않는다
 * - 장면에 없는 인물은 플레이어가 아는 공개 정보만 넣는다
 * - 숨은 목격자는 행적 시점에 드러나지 않는다. 그 인물이 장면에 들어오면 "이 인물이 아는 당신의 행적"으로만 반영된다
 * - 비밀은 신뢰가 공개 조건을 넘었을 때 "털어놓을 수 있다"는 사실만 알리고, 내용은 reveal_secret 결과로만 나온다
 */

/** 프롬프트에 넣을 최근 Belief 수 */
export const MAX_BELIEFS_IN_PROMPT = 30;

const VALUE_LABELS: Record<string, string> = {
  discipline: "규율",
  loyalty: "의리",
  mercy: "자비",
  honesty: "정직",
  self_interest: "실리",
};

function weatherLine(state: GameState, content: Content): string {
  const w = weatherNow(content.scenario, state);
  return w ? ` · 날씨: ${w.label} (${w.description})` : "";
}

const genderOf = (s: { creation?: { genders: { id: string; label: string }[] } }, id: string | null) => {
  const label = s.creation?.genders.find((g) => g.id === id)?.label;
  return label ? ` · ${label}` : "";
};

export function describePlayerState(state: GameState, content: Content): string {
  const player = state.characters[state.playerId];
  if (!player) throw new Error("플레이어 캐릭터가 없습니다.");

  const scenario = content.scenario;
  const stats = scenario.stats.map((s) => `${s.label}(${s.id}) ${signed(player.stats[s.id] ?? 0)}`).join(", ");
  const difficulty = Object.entries(DIFFICULTY_MODIFIER)
    .map(([k, v]) => `${k} ${signed(v)}`)
    .join(", ");

  const sections = [
    [
      `시각: ${formatTime(state.time)}${weatherLine(state, content)}`,
      `캐릭터: ${player.name} (id: ${player.id}) · ${content.roles[state.roleId]?.rank === player.rank ? content.roles[state.roleId]!.label : rankLabel(scenario, player.rank)}${genderOf(scenario, player.gender)}${player.age ? ` · ${player.age}세` : ""}`,
      `트레잇 (서술에 반영한다): ${traitLabels(content, player, { acting: true }).join(", ") || "없음"}`,
      `능력: ${stats}`,
      `스킬 (판정 보정 = 능력 + 스킬, 최대 ${signed(scenario.ranges.cap)}): ${scenario.moves.map((m) => `${m.label}(${m.id}) ${signed(player.skills[m.id] ?? m.default)}`).join(", ")}`,
      ...(player.skillPoints > 0 ? [`레벨업 대기: 올릴 스킬 ${player.skillPoints}개. 적당한 때 플레이어에게 무엇을 올릴지 묻고 learn_skill로 올린다`] : []),
      `상태: ${describeConditions(scenario, player)} (판정 보정 ${signed(conditionPenalty(scenario, player))})`,
      `소지품: ${describeInventory(content, player.inventory)}`,
      `장면에 놓인 물건: ${describeInventory(content, state.scene.items)}`,
      `난이도 보정: ${difficulty}`,
    ].join("\n"),
    describeBattleForGm(state, content),
    describeStoryletForGm(state, content),
    describeMissionsForGm(state, { content }),
    describeFactionsForGm(state, content),
    describeOwnDeeds(state),
    describePresentNpcs(state, content, player),
    describeKnownPeople(state, content),
    describeZonePeople(state, content),
    describeZoneExtras(state, content),
    describeExtraTemplates(content),
    describeBeliefs(state),
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** 이번 턴의 user 메시지. 상태와 입력을 구분해 넣는다 */
/**
 * 이번 턴의 user 메시지. 고정 부분(시스템 프롬프트)은 앞에서 캐싱되고, 이 메시지에는 바뀌는 것만 둔다:
 * 지난 이야기(모드 전환 직후) → 상태 → 참고 자료(RAG) → 플레이어 입력
 */
export function buildPlayerPrompt(state: GameState, content: Content, input: string, recap = "", references = ""): string {
  const recapBlock = recap ? `<지난 이야기>\n${recap}\n</지난 이야기>\n\n` : "";
  const refBlock = references
    ? `<참고 자료>\n캐릭터가 알 수 있는 세계 배경과 지난 기억이다. 필요할 때만 쓰고, 여기 없는 사실을 지어내지 않는다. 기억은 캐릭터가 그때 보고 들은 것이라 틀렸을 수 있다.\n\n${references}\n</참고 자료>\n\n`
    : "";
  return `${recapBlock}<상태>\n${describePlayerState(state, content)}\n</상태>\n\n${refBlock}<플레이어 입력>\n${input}\n</플레이어 입력>`;
}

/** 끌림·질투 (기획서 4.6 "외모와 끌림"): GM이 태도로 연기한다 */
function attractionNotes(content: Content, npc: Character, player: Character): string[] {
  if (!attractionOf(content, npc)) return [];
  if (oppositeSex(npc, player)) return ["끌림: 이 인물은 이성인 당신에게 끌린다 (호감이 빨리 오르고, 당신의 설득·거짓말에 약하다). 말이 많아지거나 허세를 부린다"];
  if (sameSex(npc, player) && looksOf(content, player) > 0) return ["질투: 이 인물은 같은 성별인 당신의 외모를 질투한다. 비꼬거나 경쟁하려 든다"];
  return [];
}

function describePresentNpcs(state: GameState, content: Content, player: Character): string {
  if (state.scene.present.length === 0) return "함께 있는 인물: 없음 (이름 있는 인물이 등장하면 npc_presence로 알린다)";
  const cards = state.scene.present.map((id) => {
    const npc = content.npcs[id];
    const character = state.characters[id];
    if (npc && character) return describeNpcCard(state, content, npc, character, player);
    if (character?.extra) return describeExtraCard(state, content, character, player);
    return `- ${id}`;
  });
  return `함께 있는 인물:\n${cards.join("\n\n")}`;
}

/** 엑스트라의 연기용 카드: 호칭, 겉모습, 상태, 지닌 것, 트레잇, 이름을 아는지 */
function describeExtraCard(state: GameState, content: Content, c: Character, player: Character): string {
  const ex = c.extra!;
  const relation = state.relations[c.id]?.[player.id] ?? NEUTRAL_RELATION;
  const attitude = RELATION_AXES.map((axis) => `${RELATION_AXIS_LABELS[axis]} ${relationLabel(relation[axis])}`).join(", ");
  const template = content.extras[ex.template];
  return [
    `### ${headingAs(state, content, player.id, c.id)} (${c.id}) · ${c.factionId ? (content.factions[c.factionId]?.name ?? c.factionId) + " " : ""}${rankLabel(content.scenario, c.rank)}${genderOf(content.scenario, c.gender)}${c.age ? ` · ${c.age}세` : ""}`,
    `겉모습: ${ex.look}`,
    `상태: ${describeConditions(content.scenario, c)} / 지닌 것: ${describeInventory(content, c.inventory)}${isIncapacitated(content, c) ? " / 무력화됨 (판정 없이 뒤질 수 있다)" : ""}`,
    `[GM 전용: 연기에만 쓴다] 이름 없는 인물 (틀: ${template?.label ?? ex.template}). 당신에 대한 태도: ${attitude}`,
    `트레잇: ${traitLabels(content, c, { acting: true }).join(", ") || "-"}`,
    ...attractionNotes(content, c, player),
    ...nameNotes(state, player.id, c.id),
  ]
    .filter(Boolean)
    .join("\n");
}

/** 장면에 있는 NPC의 연기용 카드. secret, doesnt_know는 절대 넣지 않는다 */
function describeNpcCard(
  state: GameState,
  content: Content,
  npc: NpcContent,
  character: Character,
  player: Character,
): string {
  const toPlayer = speechLevel(content.scenario, character, player);
  const fromPlayer = speechLevel(content.scenario, player, character);
  const values = Object.entries(npc.values)
    .map(([k, v]) => `${VALUE_LABELS[k] ?? k} ${signed(v)}`)
    .join(", ");
  const knows = (state.beliefs[npc.id] ?? []).map((b) => `  - ${b.fact}`);
  const relation = state.relations[npc.id]?.[player.id] ?? NEUTRAL_RELATION;
  const attitude = RELATION_AXES.map(
    (axis) => `${RELATION_AXIS_LABELS[axis]} ${signed(relation[axis])}(${relationLabel(relation[axis])})`,
  ).join(", ");
  const knownDeeds = Object.entries(state.deedKnowledge[npc.id] ?? {})
    .map(([deedId, source]) => {
      const deed = state.deeds[deedId];
      return deed?.actorId === player.id ? `  - ${deed.summary} (${SOURCE_LABELS[source]})` : null;
    })
    .filter((line) => line !== null)
    .slice(-5);
  const secretLine = (() => {
    if (!npc.secret) return null;
    if (state.revealedSecrets.includes(npc.id)) return `당신에게 털어놓은 비밀: ${npc.secret.content}`;
    if (relation.trust >= npc.secret.min_trust) {
      return `이 인물은 이제 당신에게 비밀을 털어놓을 수 있는 관계다. 공개 상황: ${npc.secret.reveal_when}. 상황이 맞으면 reveal_secret`;
    }
    return null;
  })();

  return [
    `### ${headingAs(state, content, player.id, npc.id)} (${npc.id}) · ${rankLabel(content.scenario, character.rank)}${genderOf(content.scenario, character.gender ?? npc.gender ?? null)} · ${npc.age}세`,
    `외모: ${npc.look}`,
    `상태: ${describeConditions(content.scenario, character)} / 소지품: ${describeInventory(content, character.inventory)}`,
    `화법: 이 인물의 말투 — ${npc.voice.style} (말투 설명이 우선. 설명에 없는 경우의 기본: 이 인물은 당신에게 ${toPlayer}, 당신은 이 인물에게 ${fromPlayer})`,
    `예시 대사: ${npc.voice.samples.map((s) => `"${s}"`).join(" / ")}`,
    `[GM 전용: 연기에만 쓰고 서술로 직접 드러내지 않는다]`,
    `당신에 대한 태도: ${attitude}`,
    `원하는 것: ${npc.want} / 두려워하는 것: ${npc.fear}`,
    `트레잇: ${traitLabels(content, character, { acting: true }).join(", ") || "-"} / 가치관: ${values || "-"}`,
    ...attractionNotes(content, character, player),
    ...nameNotes(state, player.id, npc.id),
    `행동 규칙:\n${npc.rules.map((r) => `  - ${r}`).join("\n") || "  - 없음"}`,
    `이 인물이 아는 것 (물으면 말해 줄 수 있다):\n${knows.join("\n") || "  - 특별히 없음"}`,
    ...(knownDeeds.length > 0
      ? [`이 인물이 아는 당신의 행적 (당신은 이 인물이 안다는 걸 모를 수 있다. 바로 밝히지 말고 태도에 반영):\n${knownDeeds.join("\n")}`]
      : []),
    ...(secretLine ? [secretLine] : []),
  ].join("\n");
}

/** 이미 기록된 플레이어의 최근 행적 (같은 행동을 다시 기록하지 않게). 숨은 목격자는 넣지 않는다 */
function describeOwnDeeds(state: GameState): string {
  const deeds = Object.values(state.deeds)
    .filter((d) => d.actorId === state.playerId)
    .slice(-5);
  if (deeds.length === 0) return "";
  return `이미 기록된 당신의 행적 (take_action의 deed로 다시 넣지 않는다):\n${deeds.map((d) => `- ${d.id}: ${d.summary}`).join("\n")}`;
}

/**
 * 이름을 아는지에 따른 연기 메모 (기획서 6.3). 이름을 모르면 GM이 그 이름을 쓰지 않게,
 * 상대가 당신 이름을 모르면 이름으로 부르지 않게 한다
 */
function nameNotes(state: GameState, viewer: string, id: string): string[] {
  const notes: string[] = [];
  if (!knowsName(state, viewer, id)) {
    notes.push("당신은 이 인물의 이름을 모른다 (호칭으로 부른다). 상대가 이름을 밝히거나 누가 그 이름을 부르면 learn_name(who: player). 이름을 지어내지 않는다");
  }
  notes.push(
    knowsName(state, id, viewer)
      ? "이 인물은 당신의 이름을 안다"
      : "이 인물은 당신의 이름을 모른다 (이름으로 부르지 않는다). 당신이 이름을 밝히거나 불리면 learn_name(who: target)",
  );
  return notes;
}

/** 엑스트라의 최근 목록에 넣는 수 (오래 안 본 인물은 데이터에 남아도 상태에는 넣지 않는다, *임시*) */
const RECENT_EXTRAS_IN_PROMPT = 5;

function statusNote(content: Content, character: Character): string {
  const initial = initialConditions(content.scenario);
  const changed = Object.entries(initial).some(([track, level]) => character.conditions[track] !== level);
  return character.dead ? " · 사망" : changed ? ` · ${describeConditions(content.scenario, character)}` : "";
}

/**
 * 장면에 없지만 플레이어가 아는 인물. 공개 정보만.
 * 이름을 아는 인물은 이름·평판까지, 얼굴만 아는 콘텐츠 인물은 호칭과 겉모습만 (평판은 그 인물을 아는 사람이 아는 모습이다).
 * 이름 모르는 엑스트라는 구역 목록(describeZoneExtras)에 나온다
 */
function describeKnownPeople(state: GameState, content: Content): string {
  const viewer = state.playerId;
  const absent = (id: string) => !state.scene.present.includes(id) && id !== viewer && state.characters[id];
  const named = (state.known[viewer] ?? []).filter(absent);
  const faces = (state.met[viewer] ?? []).filter((id) => absent(id) && !knowsName(state, viewer, id) && content.npcs[id]);
  const blocks: string[] = [];
  if (named.length > 0) {
    const lines = named.map((id) => {
      const character = state.characters[id]!;
      const npc = content.npcs[id];
      const gender = genderOf(content.scenario, character.gender ?? npc?.gender ?? null);
      const about = npc ? `${npc.look} ${npc.reputation}` : (character.extra?.look ?? "");
      return `- ${headingAs(state, content, viewer, id)} (${id}) · ${rankLabel(content.scenario, character.rank)}${gender}${statusNote(content, character)}: ${about}`;
    });
    blocks.push(`알고 있는 인물 (지금 장면에는 없다):\n${lines.join("\n")}`);
  }
  if (faces.length > 0) {
    const lines = faces.map((id) => `- ${headingAs(state, content, viewer, id)} (${id})${statusNote(content, state.characters[id]!)}: ${content.npcs[id]!.look}`);
    blocks.push(`얼굴만 아는 인물 (이름은 모른다. 지금 장면에는 없다):\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/**
 * 지금 구역에 있을 만한 인물 (등장시킬 수 있는 사람). 만난 적 없는 인물은 이름 없이 겉모습만 준다.
 * 만나도 이름은 모른다 (learn_name). 비밀·평판 같은 프로필은 장면에 들어온 뒤에만 넣는다
 */
export function describeZonePeople(state: GameState, content: Content): string {
  const zone = state.playerZone;
  if (!zone) return "";
  const people = Object.values(content.npcs).filter(
    (npc) => npc.zone === zone && npc.id !== state.playerId && !state.scene.present.includes(npc.id) && !state.characters[npc.id]?.dead,
  );
  const strangers = people.filter((npc) => !hasMet(state, state.playerId, npc.id));
  if (strangers.length === 0) return "";
  const lines = strangers.map((npc) => `- (${npc.id}) 이름 모름: ${npc.look}`);
  return `이 구역에서 마주칠 수 있는 낯선 사람 (등장시키려면 npc_presence. 만나도 이름은 모른다):\n${lines.join("\n")}`;
}

/** 이 구역에서 전에 엮인, 이름을 모르는 엑스트라 (다시 마주칠 수 있다. npc_presence로 다시 등장시킨다). 최근 몇 명만 */
function describeZoneExtras(state: GameState, content: Content): string {
  const zone = state.playerZone;
  if (!zone) return "";
  const list = Object.values(state.characters)
    .filter((c) => c.extra && c.extra.zone === zone && !state.scene.present.includes(c.id) && !knowsName(state, state.playerId, c.id))
    .sort((a, b) => b.extra!.lastSeenAt - a.extra!.lastSeenAt)
    .slice(0, RECENT_EXTRAS_IN_PROMPT);
  if (list.length === 0) return "";
  const lines = list.map((c) => `- (${c.id}) ${aliasOf(state, content, c.id)}${c.dead ? " · 죽음" : ""}: ${c.extra!.look}`);
  return `이 구역에서 전에 엮인 이름 모르는 인물 (최근 ${RECENT_EXTRAS_IN_PROMPT}명까지. 다시 등장시키려면 npc_presence):\n${lines.join("\n")}`;
}

/** 플레이어의 Belief. 출처는 넣고 진짜 정확도는 넣지 않는다 */
function describeBeliefs(state: GameState): string {
  const beliefs = (state.beliefs[state.playerId] ?? []).slice(-MAX_BELIEFS_IN_PROMPT);
  if (beliefs.length === 0) return "";
  const lines = beliefs.map((b) => `- [${BELIEF_SOURCE_LABELS[b.source]}] ${b.fact}`);
  return `당신이 알고 있다고 믿는 것 (틀렸거나 오래된 정보일 수 있다):\n${lines.join("\n")}`;
}

function describeInventory(content: Content, inventory: Inventory): string {
  const entries = Object.entries(inventory);
  if (entries.length === 0) return "없음";
  return entries.map(([id, qty]) => `${content.items[id]?.name ?? id}(${id}) ×${qty}`).join(", ");
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
