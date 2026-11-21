/**
 * 공통 규칙 16: 자기다움 (docs/design.md "공통 규칙", 4.6.4, 12-246).
 *
 * 캐릭터의 성향이 플레이어의 뜻을 꺾는 굴림은 여기서 한다:
 * - 성격 (12-99, 12-107): 도발에 발끈(rollBlowup), 말이 새어 나감(rollLeak), 얻어들음(rollHear) — engine/persona.ts의 것을 여기로 모은다
 * - 설정 거스르기: 이상·금기·결점(rolls 칸)을 거스르는 행동이면 GM이 먼저 서술로 확인하고, 그래도 하면 take_action.against_setting으로 굴린다.
 *   판정은 마음 다잡기(body.steady)와 같은 정신력, 못 함의 예외는 공통 규칙 12 (reaction).
 *   성공: 뜻대로 / 대가 있는 성공: 뜻대로 하되 마음이 한 단계 흔들린다 / 실패: 하지 못한다 (GM이 행동을 바꾸고 까닭을 짧게)
 * - 같은 장면(같은 자리, SCENE_MINUTES 안)에서 같은 설정은 한 번만 굴린다: 이겨 냈으면 다시 막지 않고, 꺾였으면 다시 굴리지 않는다
 * 설정 굴림의 기록은 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import { josa } from "../text.ts";
import { rollPlayerCheck } from "../engine/checks.ts";
import { shakeNerves } from "../engine/body.ts";
import type { ToolContext, ToolDisplayEvent } from "../engine/toolkit.ts";
import { settingOf } from "../game/settings.ts";
import { spotKey } from "../game/state.ts";
import { currentPlace } from "./place.ts";
export { rollBlowup, rollHear, rollLeak } from "../engine/persona.ts";

/** 같은 장면으로 치는 시간 (분) */
export const SCENE_MINUTES = 360;

export type SettingRoll = { ok: true; proceed: boolean; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string };

/** 설정을 거스르는 행동: 굴려서 해낼지 정한다 */
export function againstSetting(ctx: ToolContext, settingId: string): SettingRoll {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const s = ctx.content.scenario;
  const item = settingOf(s, settingId);
  if (!me || !item || !me.settings.includes(settingId)) return { ok: false, error: `주인공의 설정이 아니다: ${settingId} (상태의 '설정'에서 고른다).` };
  const slot = s.settings?.slots.find((x) => x.id === item.slot);
  if (!slot?.rolls) return { ok: false, error: `${josa(item.name, "은/는")} 거스를 때 굴리는 설정이 아니다 (이상·금기·결점만). 대사와 몸짓으로만 드러낸다.` };
  const spot = spotKey(state.playerZone ?? "", currentPlace(state, ctx.content)?.id ?? null);
  const before = state.settingRolls?.[settingId];
  const sameScene = !!before && before.spot === spot && state.time - before.at <= SCENE_MINUTES;
  if (sameScene && before.won) return { ok: true, proceed: true, lines: [`(${item.name}: 이 장면에서 이미 이겨 냈다. 다시 굴리지 않는다)`], displays: [] };
  if (sameScene && !before.won) return { ok: true, proceed: false, lines: [`${josa(`${item.confirm ?? item.name} ${me.name}`, "은/는")} 이 장면에서 이미 꺾였다: 그 행동을 하지 못한다. 다른 행동으로 바꿔 서술하라 (다시 굴리지 않는다).`], displays: [] };
  const rule = s.body?.steady;
  if (!rule) return { ok: true, proceed: true, lines: [], displays: [] };
  const roll = rollPlayerCheck({ move: rule.move, stat: rule.stat, difficulty: "normal", intent: `${josa(item.name, "을/를")} 거스른다` }, ctx, { reaction: true, purpose: "reaction" });
  if (!roll.ok) return roll;
  const won = roll.outcome !== "miss";
  ctx.store.append({ type: "setting_rolled", setting: settingId, spot, won });
  const who = `${item.confirm ?? item.name} ${me.name}`;
  // 판정 줄에는 스킬 이름(버티기)만 나와 무슨 굴림인지 몰랐다 (PT14): 설정을 거스르는 마음의 굴림임을 먼저 밝힌다
  const head = `(${josa(item.name, "을/를")} 거스르는 마음의 굴림)`;
  if (roll.outcome === "success") return { ok: true, proceed: true, lines: [head, `${josa(who, "은/는")} 마음에 걸리는 것을 누르고 해낸다.`], displays: [roll.display] };
  if (roll.outcome === "partial") {
    const shaken = shakeNerves(ctx, 1, `${josa(item.name, "을/를")} 거슬렀다`, false);
    return { ok: true, proceed: true, lines: [head, `${josa(who, "은/는")} 뜻대로 하지만 마음이 흔들린다.`, ...shaken.lines], displays: [roll.display, ...shaken.displays] };
  }
  return { ok: true, proceed: false, lines: [head, `${josa(who, "은/는")} 끝내 하지 못한다: 그 행동은 일어나지 않았다. GM은 행동을 바꿔 서술하고 까닭(${item.name})을 짧게 알린다.`], displays: [roll.display] };
}

/** 설정의 주인 쪽 카드 줄 (연기 카드, 주인공·NPC 공통). 주인공이면 비밀의 사실과 아는 사람, 거스를 때의 안내까지 */
export function settingLines(content: { scenario: ToolContext["content"]["scenario"] }, state: ReturnType<ToolContext["store"]["getState"]>, c: { id: string; settings: readonly string[] }, options: { player?: boolean; name?: (id: string) => string } = {}): string[] {
  const s = content.scenario;
  const items = c.settings.map((id) => settingOf(s, id)).filter((x) => !!x);
  if (!items.length) return [];
  const slotOf = (slot: string) => s.settings?.slots.find((x) => x.id === slot);
  const shown = items.filter((x) => options.player || !x.fact);
  const lines: string[] = [];
  if (shown.length) {
    lines.push(
      `설정 (대사·몸짓에 조금씩 녹인다. 알리지 않는다): ${shown
        .map((x) => `${slotOf(x.slot)?.label ?? x.slot} — ${x.name}: ${x.fact && options.player ? "" : x.acting}${slotOf(x.slot)?.rolls && options.player ? ` [${x.id}]` : ""}`.replace(/: $/, ""))
        .join(" / ")}`,
    );
  }
  if (options.player && items.some((x) => slotOf(x.slot)?.rolls)) {
    lines.push("설정을 거스르는 행동이면 굴리기 전에 서술로 먼저 확인한다 (\"(확인 말) ○○은 이 선택이 마음에 걸린다. 정말 이렇게 해야 할까?\"). 물러서면 굴림 없음, 그래도 하면 take_action.against_setting에 [ ] 안의 id. 성장하는 장면이면 굴리지 않아도 된다");
  }
  const secret = options.player ? items.find((x) => x.fact) : undefined;
  if (secret) {
    const known = secretKnownBy(state, c.id);
    lines.push(
      `[GM 전용] 당신만 아는 비밀: ${secret.fact} (겉으로는: ${secret.acting}). 아는 사람: ${known.length ? known.map((id) => options.name?.(id) ?? id).join(", ") : "없음"}. ` +
        "모르는 사람은 아는 듯 말하지 않는다. 서술만으로는 아무도 알게 되지 않는다: 주인공이 털어놓으면 reveal_secret { npc_id: 들은 사람, own: true }",
    );
  }
  return lines;
}

/** 이 사람의 비밀을 아는 사람들 (털어놓은 상대와 그 자리에 있던 사람) */
export function secretKnownBy(state: ReturnType<ToolContext["store"]["getState"]>, ownerId: string): string[] {
  return state.secretKnownBy?.[ownerId] ?? [];
}

/** 인물 카드: 이 인물이 주인공의 비밀을 아나 (아는 사람의 카드에만 실린다, 원칙 4) */
export function knowsPlayerSecretLine(content: { scenario: ToolContext["content"]["scenario"] }, state: ReturnType<ToolContext["store"]["getState"]>, viewerId: string): string | null {
  const me = state.characters[state.playerId];
  if (!me || !secretKnownBy(state, me.id).includes(viewerId)) return null;
  const secret = me.settings.map((id) => settingOf(content.scenario, id)).find((x) => x?.fact);
  return secret ? `이 인물은 당신의 비밀을 안다: ${secret.fact} (태도에 반영한다)` : null;
}

/** 주인공의 비밀 (설정) */
export function playerSecret(content: { scenario: ToolContext["content"]["scenario"] }, state: ReturnType<ToolContext["store"]["getState"]>): SettingItemLike | null {
  const me = state.characters[state.playerId];
  return (me?.settings.map((id) => settingOf(content.scenario, id)).find((x) => x?.fact) as SettingItemLike | undefined) ?? null;
}
type SettingItemLike = NonNullable<ReturnType<typeof settingOf>>;

/** 주인공이 비밀을 털어놓는다: 들은 사람과 그 자리에 있던 사람이 안다 (공통 규칙 7) */
export function tellPlayerSecret(ctx: ToolContext, listenerId: string): { ok: true; fact: string; told: string[] } | { ok: false; error: string } {
  const state = ctx.store.getState();
  const secret = playerSecret(ctx.content, state);
  if (!secret?.fact) return { ok: false, error: "주인공에게는 털어놓을 비밀(설정)이 없다." };
  if (!state.scene.present.includes(listenerId)) return { ok: false, error: "장면에 없는 인물입니다." };
  const already = secretKnownBy(state, state.playerId);
  const told = state.scene.present.filter((id) => id !== state.playerId && !already.includes(id) && !!state.characters[id] && !state.characters[id].dead);
  if (!told.includes(listenerId)) return { ok: false, error: "그 인물은 이미 당신의 비밀을 안다." };
  ctx.store.append({ type: "secret_told", owner: state.playerId, to: told });
  return { ok: true, fact: secret.fact, told };
}

/** 캐릭터 시트의 설정 (자기 것이라 비밀의 사실과 아는 사람까지 보인다) */
export type SettingSheetRow = { id: string; slot: string; slotLabel: string; name: string; description: string; rolls: boolean; secret: { fact: string; knownBy: string[] } | null };
export function settingSheet(content: { scenario: ToolContext["content"]["scenario"] }, state: ReturnType<ToolContext["store"]["getState"]>, c: { id: string; settings: readonly string[] }, name: (id: string) => string): SettingSheetRow[] {
  const s = content.scenario;
  const order = (s.settings?.slots ?? []).map((x) => x.id);
  return c.settings
    .map((id) => settingOf(s, id))
    .filter((x) => !!x)
    .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot))
    .map((x) => {
      const slot = s.settings?.slots.find((y) => y.id === x.slot);
      return {
        id: x.id,
        slot: x.slot,
        slotLabel: slot?.label ?? x.slot,
        name: x.name,
        description: x.description,
        rolls: !!slot?.rolls,
        secret: x.fact ? { fact: x.fact, knownBy: secretKnownBy(state, c.id).map(name) } : null,
      };
    });
}
