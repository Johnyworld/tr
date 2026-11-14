import { z } from "zod";
import type { ItemContent } from "./schemas.ts";

/**
 * 상태 화면 아이콘 이름 (12-64). 월드 데이터(아이템·상태 트랙의 `icon`)가 고르고, 화면(packages/ui)이 그림으로 바꾼다.
 * 장르를 모르는 일반 이름만 둔다. 화면이 모르는 이름이 오면 기본 그림(box)으로 그린다
 */
export const ICON_NAMES = [
  // 물건
  "blade",
  "club",
  "gun",
  "bow",
  "fire",
  "bomb",
  "ammo",
  "helmet",
  "vest",
  "food",
  "water",
  "medicine",
  "tool",
  "light",
  "paper",
  "pen",
  "key",
  "bag",
  "cloth",
  "material",
  "box",
  // 몸 상태
  "heart",
  "hunger",
  "virus",
  "cold",
  "fever",
  "mind",
  // 날씨
  "sun",
  "cloud",
  "rain",
  "fog",
  "snow",
] as const;
export type IconName = (typeof ICON_NAMES)[number];
export const iconNameSchema = z.enum(ICON_NAMES);

/** 아이템 아이콘: 데이터에 `icon`이 있으면 그것, 없으면 성질(무기·방어구·종류)로 고른다 */
export function itemIcon(item: ItemContent | undefined): IconName {
  if (!item) return "box";
  if (item.icon) return item.icon;
  if (item.weapon) return item.weapon.ammo ? "gun" : "blade";
  if (item.armor) return item.armor.slot === "head" ? "helmet" : "vest";
  switch (item.kind) {
    case "ammo":
      return "ammo";
    case "food":
      return "food";
    case "consumable":
      return "medicine";
    case "tool":
      return "tool";
    case "material":
      return "material";
    default:
      return "box";
  }
}
