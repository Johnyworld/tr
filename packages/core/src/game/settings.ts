/**
 * 캐릭터 설정 고르기 (RP, docs/design.md 4.6.4, 12-246): 칸, 고를 수 있는지와 그 까닭.
 * 성격 조건(requires: 성격 축 한쪽 이름 → 단계)은 만들 때만 본다. 정면으로 모순되는 설정·트레잇, 시나리오의 정해진 사연과 맞지 않는 것은 고를 수 없다.
 * 시나리오와 자주 부딪히는 것은 고를 수 있지만 알린다 (clash)
 */
import type { Scenario } from "../scenario/schema.ts";

export type SettingItem = NonNullable<Scenario["settings"]>["items"][number];
export type SettingSlot = NonNullable<Scenario["settings"]>["slots"][number];
/** 고르는 자리: 성격·트레잇·시나리오(역할)·무리 */
export type SettingContext = { persona: Record<string, number> | null; traits: readonly string[]; roleId?: string | null; faction?: string | null };

export function settingSlots(s: Scenario): SettingSlot[] {
  return s.settings?.slots ?? [];
}

export function settingOf(s: Scenario, id: string): SettingItem | undefined {
  return s.settings?.items.find((x) => x.id === id);
}

/** 성격 조건을 채우지 못한 것 ("다혈질 2 필요") */
export function unmetRequires(s: Scenario, persona: Record<string, number> | null, requires: Record<string, number>): string[] {
  const missing: string[] = [];
  for (const [pole, n] of Object.entries(requires)) {
    const axis = s.persona?.axes.find((a) => a.high === pole || a.low === pole);
    const v = axis ? (persona?.[axis.id] ?? 0) : 0;
    const ok = !!axis && (axis.high === pole ? v >= n : v <= -n);
    if (!ok) missing.push(`${pole} ${n} 필요`);
  }
  return missing;
}

/** 이 설정을 지금 고를 수 있는가: 까닭(못 고르면), 자주 부딪힘 */
export function settingStatus(s: Scenario, item: SettingItem, ctx: SettingContext, chosen: readonly string[]): { ok: boolean; reasons: string[]; clash: boolean } {
  const reasons = [...unmetRequires(s, ctx.persona, item.requires)];
  const against = chosen.filter((id) => id !== item.id && (item.opposites.includes(id) || settingOf(s, id)?.opposites.includes(item.id)));
  if (against.length) reasons.push(`함께 고를 수 없음: ${against.map((id) => settingOf(s, id)?.name ?? id).join(", ")}`);
  const traits = item.trait_opposites.filter((t) => ctx.traits.includes(t));
  if (traits.length) reasons.push(`트레잇과 함께 고를 수 없음: ${traits.map((t) => s.traits.find((x) => x.id === t)?.label ?? t).join(", ")}`);
  if (ctx.roleId && item.roles_none.includes(ctx.roleId)) reasons.push("이 시나리오의 사연과 맞지 않는다");
  if (ctx.faction && item.factions_none.includes(ctx.faction)) reasons.push("이 무리의 시나리오에서는 고를 수 없다");
  if (item.needs_faction && ctx.roleId && !ctx.faction) reasons.push("무소속은 고를 수 없다");
  return { ok: reasons.length === 0, reasons, clash: !!ctx.roleId && item.clashes_roles.includes(ctx.roleId) };
}

/** 고른 설정이 규칙에 맞는가 (모르는 것, 칸의 개수, 고를 수 없는 것) */
export function checkSettings(s: Scenario, ids: readonly string[], ctx: SettingContext): string[] {
  const problems: string[] = [];
  if (!ids.length) return problems;
  if (!s.settings) return ["이 월드에는 캐릭터 설정이 없다."];
  for (const id of ids) {
    const item = settingOf(s, id);
    if (!item) {
      problems.push(`모르는 설정: ${id}`);
      continue;
    }
    const st = settingStatus(s, item, ctx, ids);
    if (!st.ok) problems.push(`${item.name}: ${st.reasons.join(", ")}`);
  }
  if (new Set(ids).size !== ids.length) problems.push("같은 설정을 두 번 골랐다.");
  for (const slot of settingSlots(s)) {
    const n = ids.filter((id) => settingOf(s, id)?.slot === slot.id).length;
    if (n > slot.max) problems.push(`${slot.label}은(는) ${slot.max}개까지다.`);
  }
  return problems;
}
