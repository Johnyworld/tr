import { z } from "zod";
import { statsSchema } from "../rules/stats.ts";

/**
 * 콘텐츠 YAML 스키마. 키는 YAML과 같은 snake_case를 쓴다.
 * 스키마를 바꾸면 content/ 의 기존 파일도 함께 고친다 (pnpm content:check 로 확인).
 */

export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");

export const itemContentSchema = z.strictObject({
  id: contentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ItemContent = z.infer<typeof itemContentSchema>;

export const roleContentSchema = z.strictObject({
  id: contentIdSchema,
  label: z.string().min(1),
  faction: contentIdSchema,
  rank: z.string().min(1),
  default_name: z.string().min(1),
  start_stats: statsSchema,
  start_inventory: z.array(contentIdSchema),
  start_location: contentIdSchema.optional(),
  access: z.array(contentIdSchema).default([]),
  beliefs_preset: contentIdSchema.optional(),
  storylet_tags: z.array(contentIdSchema).default([]),
});
export type RoleContent = z.infer<typeof roleContentSchema>;

/** 게임이 쓰는 콘텐츠 전체. 지금은 아이템과 역할만 있고, 단계별로 늘어난다 */
export type Content = {
  items: Record<string, ItemContent>;
  roles: Record<string, RoleContent>;
};
