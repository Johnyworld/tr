import type { z } from "zod";
import type { Rng } from "../rng.ts";
import type { CheckOutcome } from "../rules/check.ts";
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
      modifiers: { stat: number; skill: number; difficulty: number; condition: number };
      total: number;
      outcome: CheckOutcome;
      outcomeLabel: string;
    }
  | {
      type: "harm";
      targetName: string;
      /** 상태 트랙 이름 (예: 부상) */
      trackLabel: string;
      severityLabel: string;
      fatal: boolean;
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
  | { type: "battle"; event: "started" | "round" | "ended"; title: string; detail: string }
  | { type: "storylet"; event: "started" | "resolved" | "expired"; title: string; detail: string }
  | { type: "epitaph"; name: string; text: string }
  | { type: "growth"; name: string; skill: string; from: string; to: string }
  | { type: "heal"; targetName: string; trackLabel: string; fromLabel: string; toLabel: string; byLabel: string }
  | {
      type: "deed";
      summary: string;
      tagLabels: string[];
      /** 보이는 목격자만. 숨은 목격자는 절대 넣지 않는다 */
      visibleWitnesses: string[];
    }
  | {
      type: "time";
      activityLabel: string;
      durationLabel: string;
      fromLabel: string;
      toLabel: string;
      /** 빨리감기가 중간에 멈춘 이유 */
      interruptDetail?: string;
    };

/** tool 명세 (JSON Schema). 웹 앱 모드의 LLM tool과 MCP tool이 같이 쓴다 */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: unknown; required?: string[]; [key: string]: unknown };
};

export type ToolOutcome =
  | {
      ok: true;
      resultText: string;
      display: ToolDisplayEvent;
      /** 함께 보여 줄 결과 (예: 진급) */
      extra?: ToolDisplayEvent[];
      /** true면 display를 화면에 보여 주지 않는다 (보여 줄 결과가 없는 턴) */
      silent?: boolean;
    }
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

/** strict tool에서 지원하지 않을 수 있는 제약. 지우고 zod로 검증한다 */
export const STRICT_UNSUPPORTED_KEYS = [
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "default",
];
