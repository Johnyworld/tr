/**
 * 공통 규칙 13: 피해의 셈 (docs/design.md "공통 규칙").
 *
 * 다치는 단계는 어디서 다치든 이 순서로 셈한다 (12-241, 플레이 테스트 13: 판정·이야기·탐험이 셈을 따로 해서
 * 이야기의 물림은 방어구가 막지 않았고, "○단계를 버텨 냈다"에 까닭이 없었다):
 *   기본 단계(+상대의 몫) → 방어구(맞서는 것이 낸 상처일 때) → 버팀(레벨) → 곁의 사람이 나눔(상대가 있는 판정에서 2단계일 때)
 * 단계마다 까닭 줄을 함께 돌려준다. 버팀과 방어구는 이 모듈로만 셈한다 (rules/guards.test.ts).
 */
import { josa } from "../text.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { armorAbsorb } from "../engine/gear.ts";
import { resistSteps } from "../engine/growth.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { shareHarmWith } from "./company.ts";

/** 버팀 (12-109): 레벨만큼 단계를 피한다. 피했으면 까닭 줄 */
export function resist(ctx: ToolContext, who: string, steps: number): { steps: number; line: string | null } {
  const state = ctx.store.getState();
  const c = state.characters[who];
  if (!c || steps <= 0) return { steps, line: null };
  const level = c.level ?? 1;
  const kept = resistSteps(ctx.content.scenario, level, steps, ctx.rng);
  if (kept >= steps) return { steps, line: null };
  const name = who === state.playerId ? c.name : playerCalls(state, ctx.content, who);
  return { steps: kept, line: `${josa(name, "은/는")} 몸에 밴 버팀(레벨 ${level})으로 ${steps - kept}단계를 피했다.` };
}

export type HarmInput = {
  /** 다치는 사람 */
  who: string;
  /** 기본 단계 (상대의 몫까지 더한 것) */
  raw: number;
  /** 맞서는 것(사람·짐승·감염체)이 낸 상처: 방어구가 막는다 */
  attack: boolean;
  /** 곁의 사람이 나눌 수 있다 (상대가 있는 판정) */
  shareable: boolean;
  /** 나눠 받은 사람이 입는 상처의 까닭 */
  cause: string;
  /** 부상 트랙 id (나눌 때 쓴다) */
  track: string;
  /** 나눠 받은 사람을 다치게 하는 함수 (body.changeCondition, 순환 import를 피한다) */
  hurt?: (who: string, steps: number, cause: string) => string | null;
};

/** 셈한 결과: 남은 단계, 방어구가 다 받아 냈는지(몸에 닿지 않음), 까닭 줄 */
export function reduceHarm(ctx: ToolContext, input: HarmInput): { steps: number; armored: boolean; lines: string[] } {
  const lines: string[] = [];
  const absorbed = input.attack && input.who === ctx.store.getState().playerId ? armorAbsorb(ctx, input.raw) : { steps: input.raw, lines: [] as string[] };
  lines.push(...absorbed.lines);
  const r = resist(ctx, input.who, absorbed.steps);
  if (r.line) lines.push(r.line);
  let steps = r.steps;
  if (steps >= 2 && input.shareable && input.hurt) {
    const state = ctx.store.getState();
    const mate = shareHarmWith(state, ctx.content);
    if (mate) {
      steps -= 1;
      const hurtLine = input.hurt(mate, 1, `${input.cause} (막아서다)`);
      lines.push(`${josa(playerCalls(state, ctx.content, mate), "이/가")} 막아서다 대신 다쳤다.${hurtLine ? ` ${hurtLine}` : ""}`);
    }
  }
  return { steps, armored: absorbed.steps <= 0, lines };
}
