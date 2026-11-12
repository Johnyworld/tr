import { DIFFICULTY_MODIFIER } from "../rules/check.ts";
import { INJURY_LABELS, INJURY_PENALTY } from "../rules/injury.ts";
import { STAT_LABELS, STATS } from "../rules/stats.ts";
import type { Inventory } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import type { Content } from "../content/schemas.ts";

/**
 * 이번 턴에 GM에게 보여 줄 플레이어 캐릭터 상태.
 * 현재 캐릭터 자신이 아는 것만 넣는다 (CLAUDE.md 원칙 4).
 */
export function describePlayerState(state: GameState, content: Content): string {
  const player = state.characters[state.playerId];
  if (!player) throw new Error("플레이어 캐릭터가 없습니다.");

  const stats = STATS.map((s) => `${STAT_LABELS[s]}(${s}) ${signed(player.stats[s])}`).join(", ");
  const penalty = INJURY_PENALTY[player.injury];
  const difficulty = Object.entries(DIFFICULTY_MODIFIER)
    .map(([k, v]) => `${k} ${signed(v)}`)
    .join(", ");

  return [
    `캐릭터: ${player.name} (id: ${player.id}) · ${content.roles[state.roleId]?.label ?? player.rank}`,
    `능력치: ${stats}`,
    `부상: ${INJURY_LABELS[player.injury]} (판정 보정 ${signed(penalty)})`,
    `소지품: ${describeInventory(content, player.inventory)}`,
    `장면에 놓인 물건: ${describeInventory(content, state.scene.items)}`,
    `난이도 보정: ${difficulty}`,
  ].join("\n");
}

/** 이번 턴의 user 메시지. 상태와 입력을 구분해 넣는다 */
export function buildPlayerPrompt(state: GameState, content: Content, input: string): string {
  return `<상태>\n${describePlayerState(state, content)}\n</상태>\n\n<플레이어 입력>\n${input}\n</플레이어 입력>`;
}

function describeInventory(content: Content, inventory: Inventory): string {
  const entries = Object.entries(inventory);
  if (entries.length === 0) return "없음";
  return entries
    .map(([id, qty]) => `${content.items[id]?.name ?? id}(${id}) ×${qty}`)
    .join(", ");
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
