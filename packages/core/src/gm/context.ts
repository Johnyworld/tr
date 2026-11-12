import { DIFFICULTY_MODIFIER } from "../rules/check.ts";
import { INJURY_LABELS, INJURY_PENALTY } from "../rules/injury.ts";
import { RANK_LABELS, speechLevel } from "../rules/ranks.ts";
import { STAT_LABELS, STATS } from "../rules/stats.ts";
import { formatTime } from "../rules/time.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { Character, Inventory } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import type { Content, NpcContent } from "../content/schemas.ts";
import { describeMissionsForGm } from "./missionTools.ts";

/**
 * 정보 필터 (기획서 6.2).
 * GM 프롬프트에는 현재 캐릭터의 Belief State와 그 캐릭터가 볼 수 있는 것만 넣는다 (CLAUDE.md 원칙 4).
 * - 플레이어의 믿음은 출처와 함께 넣고, 진짜 정확도(accuracy)는 넣지 않는다
 * - 장면에 있는 NPC는 연기에 필요한 프로필을 넣되, 비밀(secret)과 모르는 것(doesnt_know)은 넣지 않는다
 * - 장면에 없는 인물은 플레이어가 아는 공개 정보만 넣는다
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

export function describePlayerState(state: GameState, content: Content): string {
  const player = state.characters[state.playerId];
  if (!player) throw new Error("플레이어 캐릭터가 없습니다.");

  const stats = STATS.map((s) => `${STAT_LABELS[s]}(${s}) ${signed(player.stats[s])}`).join(", ");
  const difficulty = Object.entries(DIFFICULTY_MODIFIER)
    .map(([k, v]) => `${k} ${signed(v)}`)
    .join(", ");

  const sections = [
    [
      `시각: ${formatTime(state.time)}`,
      `캐릭터: ${player.name} (id: ${player.id}) · ${content.roles[state.roleId]?.label ?? RANK_LABELS[player.rank]}${player.age ? ` · ${player.age}세` : ""}`,
      `능력치: ${stats}`,
      `부상: ${INJURY_LABELS[player.injury]} (판정 보정 ${signed(INJURY_PENALTY[player.injury])})`,
      `소지품: ${describeInventory(content, player.inventory)}`,
      `장면에 놓인 물건: ${describeInventory(content, state.scene.items)}`,
      `난이도 보정: ${difficulty}`,
    ].join("\n"),
    describeMissionsForGm(state, { content }),
    describePresentNpcs(state, content, player),
    describeKnownPeople(state, content),
    describeBeliefs(state),
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** 이번 턴의 user 메시지. 상태와 입력을 구분해 넣는다 */
export function buildPlayerPrompt(state: GameState, content: Content, input: string): string {
  return `<상태>\n${describePlayerState(state, content)}\n</상태>\n\n<플레이어 입력>\n${input}\n</플레이어 입력>`;
}

function describePresentNpcs(state: GameState, content: Content, player: Character): string {
  if (state.scene.present.length === 0) return "함께 있는 인물: 없음 (이름 있는 인물이 등장하면 npc_presence로 알린다)";
  const cards = state.scene.present.map((id) => {
    const npc = content.npcs[id];
    const character = state.characters[id];
    return npc && character ? describeNpcCard(state, content, npc, character, player) : `- ${id}`;
  });
  return `함께 있는 인물:\n${cards.join("\n\n")}`;
}

/** 장면에 있는 NPC의 연기용 카드. secret, doesnt_know는 절대 넣지 않는다 */
function describeNpcCard(
  state: GameState,
  content: Content,
  npc: NpcContent,
  character: Character,
  player: Character,
): string {
  const toPlayer = speechLevel(character, player);
  const fromPlayer = speechLevel(player, character);
  const values = Object.entries(npc.values)
    .map(([k, v]) => `${VALUE_LABELS[k] ?? k} ${signed(v)}`)
    .join(", ");
  const knows = (state.beliefs[npc.id] ?? []).map((b) => `  - ${b.fact}`);

  return [
    `### ${npc.name} (${npc.id}) · ${RANK_LABELS[character.rank]} · ${npc.age}세`,
    `외모: ${npc.look}`,
    `부상: ${INJURY_LABELS[character.injury]} / 소지품: ${describeInventory(content, character.inventory)}`,
    `화법: 이 인물은 당신에게 기본적으로 ${toPlayer}, 당신은 이 인물에게 ${fromPlayer}. 말투: ${npc.voice.style}`,
    `예시 대사: ${npc.voice.samples.map((s) => `"${s}"`).join(" / ")}`,
    `[GM 전용: 연기에만 쓰고 서술로 직접 드러내지 않는다]`,
    `원하는 것: ${npc.want} / 두려워하는 것: ${npc.fear}`,
    `성격: ${npc.temperament.join(", ") || "-"} / 가치관: ${values || "-"}`,
    `행동 규칙:\n${npc.rules.map((r) => `  - ${r}`).join("\n") || "  - 없음"}`,
    `이 인물이 아는 것 (물으면 말해 줄 수 있다):\n${knows.join("\n") || "  - 특별히 없음"}`,
  ].join("\n");
}

/** 장면에 없지만 플레이어가 아는 인물. 공개 정보만 */
function describeKnownPeople(state: GameState, content: Content): string {
  const known = (state.known[state.playerId] ?? []).filter((id) => !state.scene.present.includes(id));
  if (known.length === 0) return "";
  const lines = known.map((id) => {
    const npc = content.npcs[id];
    const character = state.characters[id];
    if (!npc || !character) return `- ${id}`;
    const status = character.injury === "none" ? "" : ` · ${INJURY_LABELS[character.injury]}`;
    return `- ${npc.name} (${npc.id}) · ${RANK_LABELS[character.rank]}${status}: ${npc.look} ${npc.reputation}`;
  });
  return `알고 있는 인물 (지금 장면에는 없다):\n${lines.join("\n")}`;
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
