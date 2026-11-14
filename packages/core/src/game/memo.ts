import type { Content } from "../content/schemas.ts";
import type { Character } from "./character.ts";
import type { GameState } from "./state.ts";
import type { GameStore } from "./store.ts";

/**
 * 메모 (기획서 12-75): 메모장(writing: paper)과 펜·연필(writing: tool)을 지니면 플레이어가 메모를 적는다.
 * 메모장만 있으면 읽기만 한다. 메모는 캐릭터마다 따로 (사망 뒤 새 캐릭터는 이전 메모를 모른다).
 * 플레이어의 기록이라 세계의 사실이 아니고, 게임 시간을 쓰지 않는다
 */

export const MAX_MEMO_LENGTH = 4000;

export type MemoAccess = { read: boolean; write: boolean };

/** 이 캐릭터가 메모를 읽고 쓸 수 있는지 (가진 물건으로 정한다) */
export function memoAccess(content: Content, c: Pick<Character, "inventory">): MemoAccess {
  const has = (kind: "paper" | "tool") => Object.entries(c.inventory).some(([id, n]) => n > 0 && content.items[id]?.writing === kind);
  const read = has("paper");
  return { read, write: read && has("tool") };
}

export type MemoResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * 메모를 바꾼다. mode: replace(통째로 바꾸기) / append(새 줄로 덧붙이기) / clear(지우기).
 * 바뀐 것이 없으면 이벤트를 남기지 않는다
 */
export function writeMemo(store: GameStore, content: Content, mode: "replace" | "append" | "clear", input = ""): MemoResult {
  const state: GameState = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return { ok: false, error: "메모를 적을 캐릭터가 없습니다." };
  if (!memoAccess(content, me).write) return { ok: false, error: "메모장과 펜(또는 연필)이 있어야 적을 수 있습니다." };
  const before = state.memos[me.id] ?? "";
  const added = input.replace(/\r\n?/g, "\n");
  const text = mode === "clear" ? "" : mode === "append" ? (before ? `${before}\n${added.trim()}` : added.trim()) : added;
  if (text.length > MAX_MEMO_LENGTH) return { ok: false, error: `메모는 ${MAX_MEMO_LENGTH}자까지 적을 수 있습니다.` };
  if (text !== before) store.append({ type: "memo_written", characterId: me.id, text });
  return { ok: true, text };
}

/**
 * ?메모 뒤의 글을 적기로 읽는다 (읽기는 정보 명령어 ?메모가 한다).
 * "?메모 내용" 덧붙이기, "?메모 고침 내용" 통째로 바꾸기, "?메모 지움" 지우기. 메모 적기가 아니면 null
 */
export function parseMemoCommand(input: string): { mode: "replace" | "append" | "clear"; text: string } | null {
  const m = /^[?!](?:메모|memo)\s+([\s\S]+)$/i.exec(input.trim());
  if (!m) return null;
  const body = m[1]!.trim();
  if (/^(지움|지우기|clear)$/i.test(body)) return { mode: "clear", text: "" };
  const replace = /^(고침|고치기|replace)\s+([\s\S]+)$/i.exec(body);
  if (replace) return { mode: "replace", text: replace[2]! };
  return { mode: "append", text: body };
}
