import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameWorld } from "@trpg/core";

/**
 * MCP 모드의 상태 화면 서버 (127.0.0.1만). Claude 앱의 브라우저 패널에 띄워 두는 읽기 전용 캐릭터 시트.
 * - GET /api/status: 지금 이 MCP 세션이 연 게임의 플레이어 시트와 최근 결과 (정보 필터를 거친 core 뷰만)
 * - 나머지: 웹 앱과 같은 React 컴포넌트로 된 status.html (packages/ui). Vite 미들웨어로 바로 띄운다
 * stdout은 MCP 프로토콜 전용이라 로그는 모두 stderr로 보낸다 (원칙 12). 게임 상태는 바꾸지 않는다
 */

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));
const RECENT = 8;

export type StatusSource = { readonly world: GameWorld | null; readonly scenarioName: string };

export function statusPayload(source: StatusSource): unknown {
  const w = source.world;
  if (!w) return { open: false, scenarioName: source.scenarioName };
  const recent = w
    .transcriptView()
    .filter((e) => e.kind === "tool" || e.kind === "note")
    .slice(-RECENT)
    .reverse();
  return { open: true, scenarioName: source.scenarioName, worldId: w.id, player: w.playerView(), recent };
}

/** 상태 서버를 띄운다. 포트가 쓰이고 있으면 다음 포트로 (MCP 세션이 여럿일 수 있다). 주소를 돌려준다 */
export async function startStatusServer(source: StatusSource, firstPort: number): Promise<{ url: string; close: () => Promise<void> }> {
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
    server: { middlewareMode: true, hmr: false },
  });

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(302, { location: "/status.html" });
      res.end();
      return;
    }
    if (url.startsWith("/api/status")) {
      try {
        const body = JSON.stringify(statusPayload(source));
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
          server.close();
          await vite.close();
        },
      };
    }
  }
  await vite.close();
  throw new Error(`상태 화면을 띄울 포트가 없습니다 (${firstPort}~${firstPort + 9})`);
}
