import { z } from "zod";

export const itemDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
});
export type ItemDef = z.infer<typeof itemDefSchema>;

/**
 * 임시 아이템 목록.
 * 4단계(YAML 콘텐츠 로더)에서 content/items/ 로 옮긴다.
 */
export const TEMP_ITEMS: readonly ItemDef[] = [
  { id: "kitchen_knife", name: "부엌칼" },
  { id: "water_bottle", name: "물병" },
];
