import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameWorld } from "@trpg/core";

/**
 * MCP 모드의 상태 화면 서버 (127.0.0.1만). Claude 앱의 브라우저 패널에 띄워 두는 캐릭터 시트.
 * - GET /api/status: 지금 이 MCP 세션이 연 게임의 플레이어 시트 (정보 필터를 거친 core 뷰만. 디버그 모드면 진짜 전황 war도 함께)
 * - GET /api/status/stream: 같은 내용을 SSE로. 바뀔 때마다 밀어 준다
 * - GET·POST /api/options: 세계 설정(수위, 대화 형식, 12-63). 바꾸는 규칙은 core(GameWorld.setOptions)에 있다
 * - POST /api/stash: 소지품을 창고로 넣고 꺼낸다 (12-149). 규칙은 core(GameWorld.moveStash)
 * - POST /api/memo: 메모 탭에서 적은 메모 (12-75). 메모장과 펜·연필이 있을 때만. 규칙은 core(GameWorld.setMemo)
 * - POST /api/creation: 상태 화면에서 새 게임·새 캐릭터 고르기 (12-67). 화면에서 만드는 중일 때만 (채팅으로 만들면 화면은 보여 주기만 한다, 12-214). 규칙은 core(answerNewGame)
 * - GET /api/worlds: 메인 메뉴의 이어서 하기 목록 (12-214, 슬롯 요약)
 * - POST /api/menu: 메인 메뉴 (12-214): {action: new | open | delete, id?}
 * - POST /api/exit: 시트의 게임 종료 (12-214). GM이 턴을 진행하는 중(턴 문이 멈춰 있다)이면 거절
 * - POST /api/skill: 스킬 올리기 (12-139). 규칙은 core(GameWorld.learnSkill, GM의 learn_skill tool과 같다)
 * - POST /api/equip: 장비 착용·해제 (12-139). 규칙은 core(GameWorld.equip, GM의 equip tool과 같다)
 * - POST /api/portrait: 얼굴 없는 주인공이 얼굴을 한 번 고른다 (12-139). 규칙은 core(GameWorld.choosePortrait)
 * - GET /portraits/<팩>/<id>.png: 주인공 초상화 그림 (12-139, 월드 팩의 art/portraits/)
 * 서술은 채팅(Claude 세션)에 있다. 이 화면은 메인 메뉴·캐릭터 만들기·시트 셋으로 나뉜다 (12-214)
 * - 나머지: React로 된 status.html (packages/ui). Vite 미들웨어로 바로 띄운다
 * stdout은 MCP 프로토콜 전용이라 로그는 모두 stderr로 보낸다 (원칙 12). 게임 상태는 설정과 새 게임 고르기 말고는 바꾸지 않는다
 */

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));
/** 바뀌었는지 살피는 간격 */
const WATCH_MS = 250;

export type StatusSource = {
  readonly world: GameWorld | null;
  readonly scenarioName: string;
  /** Claude 세션에서 대화로 캐릭터를 만드는 중 (시트 대신 안내) */
  readonly creating?: boolean;
  /** 상태 화면에서 만드는 중이면 그 단계 (core newGameView). 채팅으로 만들면 null */
  readonly creation?: unknown;
  /** 화면이 보낸 만들기 답 */
  submitCreation?(input: CreationInput): Done;
  /** 상태 화면을 기다리는 GM이 있는지 */
  readonly gm?: { waiting: boolean };
  /** 메인 메뉴에서 고른 것 */
  menuAction?(input: { action: "new" | "open" | "delete"; id?: string }): Done;
  /** 이어서 하기 목록 */
  slots?(): unknown[];
  /** 시트의 게임 종료 */
  exitGame?(): Done;
  /** 주인공이 죽은 직후 GM이 서술하는 동안 보여 줄 죽기 직전 모습 */
  readonly frozenStatus?: unknown;
  /** 아직 닫지 않은 시나리오 해금 알림 (기획서 12.4.1). ×를 누를 때까지 화면 위에 남는다 */
  unlockNotices?(): { pack: string; roleId: string; title: string; particle?: string }[];
  dismissUnlockNotice?(pack: string, roleId: string): boolean;
  /** 디버그 모드 (TRPG_DEBUG=1): 지도 탭에 진짜 전황을 함께 싣는다. 상태 화면에만, GM에게는 가지 않는다 */
  readonly debug?: boolean;
};

type Done = { ok: true } | { ok: false; error: string };
type CreationInput = { answer?: string | string[]; back?: boolean; menu?: boolean; version?: number };

export function statusPayload(source: StatusSource, gate?: TurnGate): unknown {
  // 해금 알림은 어느 화면에서든 함께 (토스트). 시트가 멈춰 있으면(GM이 서술하는 중) 멈춘 때의 알림 중 아직 닫지 않은 것만:
  // 새 알림은 서술이 끝난 뒤 시트와 함께 뜨고, 닫은 알림은 바로 사라진다
  const pending = source.unlockNotices?.() ?? [];
  const held = !source.creating && source.world ? (gate?.held(source) as Record<string, unknown> | null | undefined) : null;
  if (held) {
    const shown = ((held.unlockNotices ?? []) as { pack: string; roleId: string }[]).filter((n) => pending.some((p) => p.pack === n.pack && p.roleId === n.roleId));
    const { unlockNotices: _, ...rest } = held;
    return shown.length ? { ...rest, unlockNotices: shown } : rest;
  }
  const body = { ...(baseStatus(source) as Record<string, unknown>), ...(source.gm ? { gm: source.gm } : {}) };
  return pending.length ? { ...body, unlockNotices: pending } : body;
}

function baseStatus(source: StatusSource): unknown {
  // 캐릭터를 만드는 중이면 그 단계 (만들어지면 첫 장면과 함께 시트가 열린다). 열린 세계가 없으면 메인 메뉴
  if (source.creating) return { open: false, creating: true, scenarioName: source.scenarioName, creation: source.creation ?? null };
  const w = source.world;
  if (!w) return { open: false, scenarioName: source.scenarioName };
  // GM이 아직 서술하는 중이면 그 턴 전의 모습 (훅의 턴 문, 또는 사망 직후)
  if (source.frozenStatus) return source.frozenStatus;
  return { open: true, scenarioName: source.scenarioName, worldId: w.id, player: w.playerView(), ...(source.debug ? { war: w.warMapView() } : {}) };
}

/** 턴 문이 풀리지 않아도 이만큼 지나면 푼다 (훅의 끝 신호를 놓쳤을 때) */
const TURN_GATE_MAX_MS = 90 * 1000;

/**
 * 턴 문 (Claude Code 훅, 기획서 11.6): 플레이어가 메시지를 보내면 상태 화면을 지금 모습에서 멈추고,
 * Claude의 답변(서술)이 끝나면 푼다. 그래서 "행동 → 채팅에 결과 서술 → 시트 갱신" 순서가 된다.
 * 신호에는 세계 id가 붙고, 이 서버가 연 세계와 같을 때만 따른다 (세션이 여럿이어도 서로 섞이지 않는다).
 * 훅이 없는 앱에서는 신호가 오지 않으니 지금처럼 바로 갱신된다
 */
export class TurnGate {
  #frozen: { worldId: string; payload: unknown; at: number } | null = null;

  start(source: StatusSource, worldId: string): boolean {
    const w = source.world;
    if (!w || w.id !== worldId) return false;
    if (!this.#frozen) this.#frozen = { worldId, payload: statusPayload(source), at: Date.now() };
    return true;
  }

  end(worldId: string): boolean {
    if (!this.#frozen || this.#frozen.worldId !== worldId) return false;
    this.#frozen = null;
    return true;
  }

  /** 멈춰 있으면 그때의 모습. 세계가 바뀌었거나 너무 오래됐으면 푼다 */
  held(source: StatusSource): unknown {
    const f = this.#frozen;
    if (!f) return null;
    if (source.world?.id !== f.worldId || Date.now() - f.at > TURN_GATE_MAX_MS) {
      this.#frozen = null;
      return null;
    }
    return f.payload;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * 세계 설정 읽기·바꾸기. 바꾸기는 JSON 본문만 받는다 (다른 사이트의 폼이 127.0.0.1로 몰래 보내지 못하게:
 * application/json은 교차 출처면 사전 요청이 필요한데 이 서버는 허락하지 않는다)
 */
export async function handleOptions(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const w = source.world;
  if (req.method === "GET") return json(res, 200, w && !source.creating ? { open: true, options: w.options() } : { open: false });
  if (req.method !== "POST") return json(res, 405, { error: "GET 또는 POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 4096) return json(res, 413, { error: "너무 크다" });
  }
  let patch: unknown;
  try {
    patch = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const result = w.setOptions(patch);
  if (!result.ok) return json(res, 400, { error: result.error });
  for (const line of result.changed) console.error(`[status] 설정: ${line}`);
  return json(res, 200, { open: true, options: result.options });
}

/** 메모 탭이 보낸 메모 (통째로). JSON만 받는다 */
export async function handleMemo(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 20000) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const text = input && typeof input === "object" ? (input as { text?: unknown }).text : undefined;
  const result = w.setMemo(text);
  if (!result.ok) return json(res, 400, { error: result.error });
  // 바뀐 화면을 응답에 함께 싣는다: SSE를 기다리는 사이 앞 단계가 다시 보이며 깜빡이지 않게
  return json(res, 200, { ok: true, status: statusPayload(source) });
}

/** 스킬 올리기 (12-139): { skill }. JSON만 받는다. 규칙은 core(GameWorld.learnSkill) */
export async function handleSkill(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 2000) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const result = w.learnSkill(input);
  if (!result.ok) return json(res, 400, { error: result.error });
  return json(res, 200, { ok: true, text: result.text, status: statusPayload(source) });
}

/** 장비 착용·해제 (12-139): { itemId } 들기·입기, { slot } 벗기. JSON만 받는다. 규칙은 core(GameWorld.equip) */
export async function handleEquip(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 2000) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const result = w.equip(input);
  if (!result.ok) return json(res, 400, { error: result.error });
  return json(res, 200, { ok: true, text: result.text, status: statusPayload(source) });
}

/** 물건 옮기기 (공통 규칙 26): 맨몸·가방·바닥·창고 사이로. JSON만 받는다. 규칙은 core(GameWorld.moveItem) */
export async function handleItemMove(source: StatusSource, req: IncomingMessage, res: ServerResponse, gate?: TurnGate): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1024) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const result = w.moveItem(input);
  if (!result.ok) return json(res, 400, { error: result.error });
  console.error(`[status] 옮기기: ${result.text}`);
  return json(res, 200, { ok: true, text: result.text, status: statusPayload(source, gate) });
}

/** 얼굴 고르기 기회 (12-139): 얼굴 없는 주인공이 얼굴을 한 번 고른다. JSON만 받는다. 규칙은 core(GameWorld.choosePortrait) */
export async function handlePortrait(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 2000) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const id = input && typeof input === "object" ? (input as { id?: unknown }).id : undefined;
  const result = w.choosePortrait(id);
  if (!result.ok) return json(res, 400, { error: result.error });
  return json(res, 200, { ok: true, status: statusPayload(source) });
}

/** 창고 (12-149): 소지품 하나를 창고로 넣거나 꺼낸다. JSON만 받는다 (설정과 같은 까닭). 규칙은 core(GameWorld.moveStash) */
export async function handleStash(source: StatusSource, req: IncomingMessage, res: ServerResponse, gate?: TurnGate): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  const w = source.world;
  if (!w || source.creating) return json(res, 409, { error: "열린 게임이 없다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1024) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const result = w.moveStash(input);
  if (!result.ok) return json(res, 400, { error: result.error });
  console.error(`[status] 창고: ${result.text}`);
  return json(res, 200, { ok: true, status: statusPayload(source, gate) });
}

/** 상태 화면에서 고른 답. JSON만 받는다 (설정과 같은 까닭) */
/** 해금 알림 닫기 (POST /api/unlock-notice {pack, roleId}) */
export async function handleUnlockNotice(source: StatusSource, req: IncomingMessage, res: ServerResponse, gate?: TurnGate): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1024) return json(res, 413, { error: "너무 크다" });
  }
  let input: { pack?: unknown; roleId?: unknown };
  try {
    input = JSON.parse(body) as typeof input;
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  if (typeof input.pack !== "string" || typeof input.roleId !== "string") return json(res, 400, { error: "pack, roleId" });
  source.dismissUnlockNotice?.(input.pack, input.roleId);
  return json(res, 200, { ok: true, status: statusPayload(source, gate) });
}

/** JSON 본문 읽기 (POST, JSON만. 다른 사이트의 폼이 몰래 보내지 못하게) */
async function readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<{ ok: true; body: unknown } | { ok: false }> {
  if (req.method !== "POST") {
    json(res, 405, { error: "POST" });
    return { ok: false };
  }
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    json(res, 415, { error: "JSON으로 보낸다" });
    return { ok: false };
  }
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > limit) {
      json(res, 413, { error: "너무 크다" });
      return { ok: false };
    }
  }
  try {
    return { ok: true, body: body ? JSON.parse(body) : {} };
  } catch {
    json(res, 400, { error: "JSON이 아니다" });
    return { ok: false };
  }
}

/** 메인 메뉴 (12-214): {action: new | open | delete, id?} */
export async function handleMenu(source: StatusSource, req: IncomingMessage, res: ServerResponse, gate?: TurnGate): Promise<void> {
  const read = await readJson(req, res, 1024);
  if (!read.ok) return;
  if (!source.menuAction) return json(res, 404, { error: "메인 메뉴가 없다" });
  const input = read.body as { action?: unknown; id?: unknown };
  const actions = ["new", "open", "delete"] as const;
  const action = actions.find((a) => a === input?.action);
  if (!action || (input.id !== undefined && (typeof input.id !== "string" || input.id.length > 200))) return json(res, 400, { error: "action(new, open, delete), id" });
  const result = source.menuAction({ action, ...(typeof input.id === "string" ? { id: input.id } : {}) });
  if (!result.ok) return json(res, 400, { error: result.error });
  return json(res, 200, { ok: true, status: statusPayload(source, gate) });
}

/** 시트의 게임 종료 (12-214). GM이 턴을 진행하는 중이면 거절 */
export async function handleExit(source: StatusSource, req: IncomingMessage, res: ServerResponse, gate?: TurnGate): Promise<void> {
  const read = await readJson(req, res, 256);
  if (!read.ok) return;
  if (!source.exitGame) return json(res, 404, { error: "게임 종료가 없다" });
  if (gate?.held(source)) return json(res, 409, { error: "GM이 이야기를 쓰는 중입니다. 답이 끝난 뒤에 다시 눌러 주세요." });
  const result = source.exitGame();
  if (!result.ok) return json(res, 400, { error: result.error });
  return json(res, 200, { ok: true, status: statusPayload(source, gate) });
}

export async function handleCreation(source: StatusSource, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON으로 보낸다" });
  if (!source.submitCreation || !source.creation) return json(res, 409, { error: "만들고 있는 캐릭터가 없습니다." });
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 8192) return json(res, 413, { error: "너무 크다" });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "JSON이 아니다" });
  }
  const ok = (x: unknown): x is CreationInput => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    const o = x as Record<string, unknown>;
    const answerOk =
      o.answer === undefined || (typeof o.answer === "string" && o.answer.length <= 1500) || // 목록: 트레잇 이름들, 또는 [동기, 이야기] (12-77)
      (Array.isArray(o.answer) && o.answer.length <= 20 && o.answer.every((a) => typeof a === "string" && a.length <= 1500) && o.answer.join("").length <= 1600);
    const flag = (v: unknown) => v === undefined || typeof v === "boolean";
    return answerOk && flag(o.back) && flag(o.menu) && (o.version === undefined || Number.isInteger(o.version));
  };
  if (!ok(input)) return json(res, 400, { error: "answer(글 또는 목록), back, menu 중 하나와 version" });
  const result = source.submitCreation(input);
  if (!result.ok) return json(res, 400, { error: result.error });
  // 바뀐 화면을 응답에 함께 싣는다: SSE를 기다리는 사이 앞 단계가 다시 보이며 깜빡이지 않게
  return json(res, 200, { ok: true, status: statusPayload(source) });
}

/** 상태 서버를 띄운다. 포트가 쓰이고 있으면 다음 포트로 (MCP 세션이 여럿일 수 있다). 주소를 돌려준다 */
export async function startStatusServer(
  source: StatusSource,
  firstPort: number,
  /** 월드 팩 id → 팩 폴더 (초상화 그림을 찾는다). 없으면 그림을 내주지 않는다 */
  packDir?: (packId: string) => string | undefined,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer: createVite, createLogger } = await import("vite");
  const base = createLogger("warn");
  const toStderr = (msg: string) => console.error(`[status] ${msg}`);
  const vite = await createVite({
    configFile: resolve(UI_DIR, "vite.config.ts"),
    root: UI_DIR,
    appType: "mpa",
    clearScreen: false,
    logLevel: "warn",
    customLogger: { ...base, info: toStderr, warn: toStderr, warnOnce: toStderr, error: toStderr, clearScreen: () => {} },
    // 읽기 전용 화면이라 HMR·웹소켓은 쓰지 않는다 (여러 MCP 세션이 떠도 포트가 겹치지 않게)
    server: { middlewareMode: true, hmr: false, ws: false },
  });

  // SSE: 바뀔 때만 밀어 준다
  const clients = new Set<ServerResponse>();
  const gate = new TurnGate();
  let last = "";
  const snapshot = () => {
    try {
      return JSON.stringify(statusPayload(source, gate));
    } catch (err) {
      return JSON.stringify({ open: false, scenarioName: source.scenarioName, error: String(err) });
    }
  };
  const send = (res: ServerResponse, body: string) => res.write(`data: ${body}\n\n`);
  const watcher = setInterval(() => {
    if (clients.size === 0) return;
    const body = snapshot();
    if (body === last) return;
    last = body;
    for (const res of clients) send(res, body);
  }, WATCH_MS);
  watcher.unref();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(302, { location: "/status.html" });
      res.end();
      return;
    }
    // 턴 문 (Claude Code 훅): /api/turn/start?world=ID, /api/turn/end?world=ID
    if (url.startsWith("/api/turn/") && req.method === "POST") {
      const parsed = new URL(url, "http://127.0.0.1");
      const worldId = parsed.searchParams.get("world") ?? "";
      const applied = parsed.pathname === "/api/turn/start" ? gate.start(source, worldId) : parsed.pathname === "/api/turn/end" ? gate.end(worldId) : false;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ applied }));
      return;
    }
    if (url === "/api/options") {
      void handleOptions(source, req, res);
      return;
    }
    if (url === "/api/memo") {
      void handleMemo(source, req, res);
      return;
    }
    if (url === "/api/skill") {
      void handleSkill(source, req, res);
      return;
    }
    if (url === "/api/equip") {
      void handleEquip(source, req, res);
      return;
    }
    if (url === "/api/portrait") {
      void handlePortrait(source, req, res);
      return;
    }
    if (url === "/api/stash") {
      void handleStash(source, req, res, gate);
      return;
    }
    if (url === "/api/item-move") {
      void handleItemMove(source, req, res, gate);
      return;
    }
    if (url === "/api/unlock-notice") {
      void handleUnlockNotice(source, req, res, gate);
      return;
    }
    if (url === "/api/creation") {
      void handleCreation(source, req, res);
      return;
    }
    if (url === "/api/menu") {
      void handleMenu(source, req, res, gate);
      return;
    }
    if (url === "/api/exit") {
      void handleExit(source, req, res, gate);
      return;
    }
    if (url === "/api/worlds" && req.method === "GET") {
      try {
        json(res, 200, { slots: source.slots?.() ?? [] });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }
    if (url.startsWith("/api/status/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      clients.add(res);
      last = snapshot();
      send(res, last);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.startsWith("/api/status")) {
      try {
        const body = JSON.stringify(statusPayload(source, gate));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
    if (url.startsWith("/api/")) {
      res.writeHead(404).end();
      return;
    }
    if (url.startsWith("/portraits/")) {
      void servePortrait(url, res, packDir);
      return;
    }
    vite.middlewares(req, res, () => res.writeHead(404).end());
  });

  for (let port = firstPort; port < firstPort + 10; port++) {
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) {
      return {
        url: `http://127.0.0.1:${port}`,
        close: async () => {
          clearInterval(watcher);
          for (const res of clients) res.end();
          server.close();
          await vite.close();
        },
      };
    }
  }
  await vite.close();
  throw new Error(`상태 화면을 띄울 포트가 없습니다 (${firstPort}~${firstPort + 9})`);
}

/** 주인공 초상화 그림 (GET /portraits/<팩>/<id>.png). 팩과 id는 이름 규칙으로 막아 폴더 밖을 읽지 않는다 */
async function servePortrait(url: string, res: ServerResponse, packDir?: (packId: string) => string | undefined) {
  const m = /^\/portraits\/([a-z][a-z0-9_]*)\/([a-z0-9_-]{1,40})\.png(?:\?.*)?$/.exec(url);
  const dir = m && packDir?.(m[1]!);
  if (!m || !dir) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(join(dir, "art", "portraits", `${m[2]}.png`));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}
