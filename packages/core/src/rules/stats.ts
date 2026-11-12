import { z } from "zod";

/** 능력치 (기획서 4.2, 초안). 범위 -1 ~ +3 */
export const STATS = ["strength", "agility", "cool", "sense", "persuasion"] as const;
export type Stat = (typeof STATS)[number];
export const statSchema = z.enum(STATS);

export const STAT_LABELS: Record<Stat, string> = {
  strength: "근력",
  agility: "민첩",
  cool: "냉정",
  sense: "감각",
  persuasion: "교섭",
};

export const STAT_MIN = -1;
export const STAT_MAX = 3;

export const statsSchema = z.strictObject(
  Object.fromEntries(STATS.map((s) => [s, z.number().int().min(STAT_MIN).max(STAT_MAX)])) as Record<
    Stat,
    z.ZodNumber
  >,
);
export type Stats = Record<Stat, number>;
