import type { TurnEvent } from "@trpg/core";
import type { GameView, PlayerView } from "./types.ts";

export type StreamEvent = TurnEvent | { type: "player"; player: PlayerView };

export async function fetchGame(): Promise<GameView> {
  const res = await fetch("/api/game");
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return (await res.json()) as GameView;
}

export async function resetGame(): Promise<GameView> {
  const res = await fetch("/api/game/reset", { method: "POST" });
  const body = (await res.json()) as GameView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `서버 오류 (${res.status})`);
  return body;
}

/**
 * POST /api/game/turn 을 호출하고 SSE 이벤트를 하나씩 돌려준다.
 * EventSource는 GET만 지원하므로 fetch 스트림을 직접 파싱한다.
 */
export async function* playTurn(input: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await fetch("/api/game/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    yield { type: "error", message: body?.error ?? `서버 오류 (${res.status})` };
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const payload = JSON.parse(data.join("\n")) as unknown;
      if (event === "player") yield { type: "player", player: payload as PlayerView };
      else yield payload as TurnEvent;
    }
  }
}
