import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { characterChoiceSchema, createSeededRng, randomAbilityBuy, randomTraits, type Content, type CreationRules, type GameWorld } from "@trpg/core";
import { z } from "zod";

/**
 * MCP 모드의 상태 화면 서버 (127.0.0.1만). Claude 앱의 브라우저 패널에 띄워 두는 읽기 전용 캐릭터 시트.
 * - GET /api/status: 지금 이 MCP 세션이 연 게임의 플레이어 시트 (정보 필터를 거친 core 뷰만)
 * - GET /api/status/stream: 같은 내용을 SSE로. 바뀔 때마다 밀어 준다
 * 서술은 채팅(Claude 세션)에 있다. 이 화면은 시트만 보여 준다
 * - 나머지: 웹 앱과 같은 React 컴포넌트로 된 status.html (packages/ui). Vite 미들웨어로 바로 띄운다
 * stdout은 MCP 프로토콜 전용이라 로그는 모두 stderr로 보낸다 (원칙 12). 게임 상태는 바꾸지 않는다
 */

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));
/** 바뀌었는지 살피는 간격 */
const WATCH_MS = 250;

export type StatusSource = {
  readonly world: GameWorld | null;
  readonly scenarioName: string;
  /** 브라우저 캐릭터 생성 (Claude 세션이 start_session(create_in_browser)로 열었을 때만 pending) */
  readonly creation?: {
    readonly pending: boolean;
    submit(choice: z.infer<ReturnType<typeof characterChoiceSchema>>): { ok: true } | { ok: false; error: string };
  };
  readonly content?: Content;
  /** 주인공이 죽은 직후 GM이 서술하는 동안 보여 줄 죽기 직전 모습 */
  readonly frozenStatus?: unknown;
  /** 브라우저 생성 직후, GM이 첫 장면을 쓰는 동안 (시트 대신 "만들었다" 안내) */
  readonly sheetHeld?: boolean;
  readonly rules?: () => CreationRules | null;
};

export function statusPayload(source: StatusSource, gate?: TurnGate): unknown {
  // 캐릭터 생성 중이면 생성 화면을 먼저 보여 준다
  if (source.creation?.pending) return { open: false, creating: true, scenarioName: source.scenarioName };
  const w = source.world;
  if (!w) return { open: false, scenarioName: source.scenarioName };
  if (source.sheetHeld) return { open: false, created: true, scenarioName: source.scenarioName, name: w.playerView().name };
  // GM이 아직 서술하는 중이면 그 턴 전의 모습 (훅의 턴 문, 또는 사망 직후)
  const held = gate?.held(source);
  if (held) return held;
  if (source.frozenStatus) return source.frozenStatus;
  return { open: true, scenarioName: source.scenarioName, worldId: w.id, player: w.playerView() };
}

/** 턴 문이 풀리지 않아도 이만큼 지나면 푼다 (훅의 끝 신호를 놓쳤을 때) */
const TURN_GATE_MAX_MS = 5 * 60 * 1000;

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

/** 상태 서버를 띄운다. 포트가 쓰이고 있으면 다음 포트로 (MCP 세션이 여럿일 수 있다). 주소를 돌려준다 */
export async function startStatusServer(
  source: StatusSource,
  firstPort: number,
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
    // 캐릭터 생성 (웹 앱과 같은 경로라 같은 생성 화면 컴포넌트가 그대로 쓴다)
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const rng = () => createSeededRng(Math.floor(Math.random() * 2 ** 31));
    if (url === "/api/creation" && req.method === "GET") return json(200, source.rules?.() ?? null);
    if (url === "/api/creation/random" && source.content) return json(200, randomAbilityBuy(source.content.scenario, rng()));
    if (url === "/api/creation/random-traits" && source.content) return json(200, randomTraits(source.content.scenario, rng()));
    if (url === "/api/worlds" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > 20000) req.destroy();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = z.object({ character: characterChoiceSchema() }).safeParse(JSON.parse(body || "{}"));
        } catch {
          return json(400, { error: "요청 형식이 올바르지 않습니다." });
        }
        if (!parsed.success) return json(400, { error: "요청 형식이 올바르지 않습니다." });
        if (!source.creation) return json(409, { error: "캐릭터 생성은 Claude 세션에서 새 게임을 고른 뒤에 합니다." });
        const r = source.creation.submit(parsed.data.character);
        return r.ok ? json(200, { ok: true }) : json(400, { error: r.error });
      });
      return;
    }
    if (url.startsWith("/api/")) {
      res.writeHead(404).end();
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
