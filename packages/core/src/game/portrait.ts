import type { Content } from "../content/schemas.ts";
import { portraitSections } from "../scenario/scenario.ts";
import type { GameStore } from "./store.ts";

/**
 * 얼굴 고르기 기회 (12-139): 얼굴 없이 만든 주인공(채팅으로 만들었거나 고르지 않음)은 시트에서 얼굴을 한 번 고를 수 있다.
 * 고르고 나면 얼굴이 생기므로 다시 고를 수 없다. 게임 시간을 쓰지 않는다
 */

/** 지금 고를 수 있는 얼굴 (화풍 섹션). 고를 수 없으면 null */
export function portraitChoices(store: GameStore, content: Content) {
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || me.portrait !== null) return null;
  const sections = portraitSections(content.scenario, me.gender);
  return sections.length > 0 ? sections : null;
}

export function choosePortrait(store: GameStore, content: Content, id: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof id !== "string") return { ok: false, error: "얼굴 id를 보낸다." };
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return { ok: false, error: "얼굴을 고를 캐릭터가 없다." };
  if (me.portrait !== null) return { ok: false, error: "이미 얼굴이 있다. 얼굴은 한 번만 고를 수 있다." };
  const sections = portraitChoices(store, content);
  if (!sections?.some((s) => s.faces.includes(id))) return { ok: false, error: "고를 수 있는 얼굴이 아니다." };
  store.append({ type: "portrait_chosen", characterId: me.id, portrait: id });
  return { ok: true };
}
