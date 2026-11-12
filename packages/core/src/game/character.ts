import { z } from "zod";
import { injuryLevelSchema } from "../rules/injury.ts";
import { statsSchema } from "../rules/stats.ts";

/** 아이템 id → 수량. 수량이 0이 되면 키를 지운다 */
export const inventorySchema = z.record(z.string(), z.number().int().positive());
export type Inventory = z.infer<typeof inventorySchema>;

/**
 * 캐릭터 스키마. 플레이어와 NPC가 같은 스키마를 쓴다 (CLAUDE.md 원칙 6).
 * 관계, Belief State, 위치 등은 해당 단계에서 필드를 추가한다.
 */
export const characterSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  factionId: z.string(),
  rank: z.string(),
  stats: statsSchema,
  injury: injuryLevelSchema,
  inventory: inventorySchema,
});
export type Character = z.infer<typeof characterSchema>;
