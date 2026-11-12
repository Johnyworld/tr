import type { z } from "zod";
import type { Rng } from "../rng.ts";
import type { CheckOutcome } from "../rules/check.ts";
import type { InjuryLevel } from "../rules/injury.ts";
import type { GameStore } from "../game/store.ts";
import type { Content } from "../content/schemas.ts";

/** UI에 보여 줄 tool 실행 결과 */
export type ToolDisplayEvent =
  | {
      type: "check";
      checkId: string;
      actorName: string;
      intent: string;
      moveLabel: string;
      statLabel: string;
      difficultyLabel: string;
      dice: [number, number];
      modifiers: { stat: number; difficulty: number; injury: number };
      total: number;
      outcome: CheckOutcome;
      outcomeLabel: string;
    }
  | {
      type: "harm";
      targetName: string;
      severityLabel: string;
      from: InjuryLevel;
      to: InjuryLevel;
      fromLabel: string;
      toLabel: string;
      cause: string;
    }
  | { type: "item"; fromName: string; toName: string; itemName: string; quantity: number }
  | { type: "presence"; npcName: string; action: "enter" | "leave" }
  | { type: "belief"; fact: string; sourceLabel: string }
  | {
      type: "mission";
      event: "assigned" | "reported" | "abandoned" | "expired";
      title: string;
      /** 결과 표시 (완수, 일부 완수, 실패, 포기, 기한 초과). 배정이면 기한 */
      detail: string;
      merit?: number;
    }
  | { type: "promotion"; name: string; fromLabel: string; toLabel: string }
  | {
      type: "time";
      activityLabel: string;
      durationLabel: string;
      fromLabel: string;
      toLabel: string;
      /** 빨리감기가 중간에 멈춘 이유 */
      interruptDetail?: string;
    };

export type ToolOutcome =
  | { ok: true; resultText: string; display: ToolDisplayEvent; /** 함께 보여 줄 결과 (예: 진급) */ extra?: ToolDisplayEvent[] }
  | { ok: false; error: string };

export type ToolContext = { store: GameStore; rng: Rng; content: Content };

export type ToolDef<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => ToolOutcome;
};

export function defineTool<S extends z.ZodType>(def: ToolDef<S>) {
  return def;
}


export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
