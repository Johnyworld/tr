import type { TurnEvent } from "@trpg/gm";
import type { CharacterChoiceView, CreationRulesView, GameView, PlayerView, SlotsView } from "./types.ts";

export type StreamEvent = TurnEvent | { type: "player"; player: PlayerView };

export async function fetchGame(): Promise<GameView> {
  const res = await fetch("/api/game");
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return (await res.json()) as GameView;
}

export type CommandInfo = { name: string; args: string; description: string };

export async function fetchCommands(): Promise<CommandInfo[]> {
  const res = await fetch("/api/commands");
  return res.ok ? ((await res.json()) as CommandInfo[]) : [];
}

/** 정보 명령어 실행 (읽기 전용) */
export async function runCommand(input: string): Promise<string> {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  const body = (await res.json()) as { output?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `서버 오류 (${res.status})`);
  return body.output ?? "";
}

export type RetrievalView = {
  turn: number;
  purpose: string;
  trace: {
    query: string;
    keywordQuery: string | null;
    candidates: number;
    filtered: number;
    dropped: string[];
    hits: { id: string; score: number; vectorRank: number | null; keywordRank: number | null }[];
  };
};

/** 개발용: 최근 RAG 검색 기록 */
export async function fetchRetrievals(): Promise<RetrievalView[]> {
  const res = await fetch("/api/dev/retrievals");
  return res.ok ? ((await res.json()) as RetrievalView[]) : [];
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `서버 오류 (${res.status})`);
  return body;
}

/** 시작 화면: 세이브 슬롯과 지금 열린 세계 */
export async function fetchSlots(): Promise<SlotsView> {
  const res = await fetch("/api/worlds");
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return (await res.json()) as SlotsView;
}

export async function newGame(character: CharacterChoiceView | null): Promise<GameView> {
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(character ? { character } : {}),
  });
  const body = (await res.json()) as GameView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `서버 오류 (${res.status})`);
  return body;
}

/** 캐릭터 생성 규칙 (없으면 null) */
export async function fetchCreation(): Promise<CreationRulesView | null> {
  const res = await fetch("/api/creation");
  if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
  return (await res.json()) as CreationRulesView | null;
}

export async function fetchRandomAbilities(): Promise<Record<string, number>> {
  const res = await fetch("/api/creation/random");
  return (await res.json()) as Record<string, number>;
}
export const openSlot = (id: string) => postJson<GameView>(`/api/worlds/${encodeURIComponent(id)}/open`);
/** 세이브 삭제 (되돌릴 수 없다) */
export async function deleteSlot(id: string): Promise<void> {
  const res = await fetch(`/api/worlds/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `서버 오류 (${res.status})`);
  }
}

/** 게임을 닫고 시작 화면으로 (세이브는 남는다) */
export const closeGame = () => postJson<{ ok: true }>("/api/game/close");

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

/** 사망 뒤 다음 캐릭터 (new 또는 인물 id) */
export async function chooseNextCharacter(characterId: string, name: string | null): Promise<GameView> {
  const res = await fetch("/api/game/succession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId, name }),
  });
  const body = (await res.json()) as GameView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `서버 오류 (${res.status})`);
  return body;
}
