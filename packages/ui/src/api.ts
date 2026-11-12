import type { ChatTurn, NarrationEvent } from "@trpg/core";

/**
 * POST /api/chat 를 호출하고 SSE 이벤트를 하나씩 돌려준다.
 * EventSource는 GET만 지원하므로 fetch 스트림을 직접 파싱한다.
 */
export async function* streamChat(
  history: ChatTurn[],
  input: string,
  signal: AbortSignal,
): AsyncGenerator<NarrationEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ history, input }),
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
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as NarrationEvent;
    }
  }
}
