import { describe, expect, it } from "vitest";
import {
  buildNarrationRequest,
  InvalidPlayerInputError,
  MAX_HISTORY_TURNS,
  MAX_INPUT_LENGTH,
  narrate,
} from "./narrate.ts";
import { GM_SYSTEM_PROMPT } from "./prompt.ts";
import type { ChatTurn, NarrationEvent, NarrationModel, NarrationRequest } from "./types.ts";

describe("buildNarrationRequest", () => {
  it("첫 입력은 user 메시지 하나가 된다", () => {
    const req = buildNarrationRequest([], "  주변을 살핀다  ");
    expect(req.system).toBe(GM_SYSTEM_PROMPT);
    expect(req.messages).toEqual([{ role: "user", content: "주변을 살핀다" }]);
  });

  it("player/gm 턴을 user/assistant로 바꾼다", () => {
    const history: ChatTurn[] = [
      { role: "player", text: "문을 연다" },
      { role: "gm", text: "녹슨 경첩이 비명을 지른다." },
    ];
    const req = buildNarrationRequest(history, "안으로 들어간다");
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("앞쪽의 GM 턴은 버린다 (첫 메시지는 user)", () => {
    const history: ChatTurn[] = [{ role: "gm", text: "오프닝 서술" }];
    const req = buildNarrationRequest(history, "일어난다");
    expect(req.messages).toEqual([{ role: "user", content: "일어난다" }]);
  });

  it("연속된 같은 역할은 합친다", () => {
    const history: ChatTurn[] = [
      { role: "player", text: "숨는다" },
      { role: "gm", text: "" }, // 중단돼 비어 버린 서술
    ];
    const req = buildNarrationRequest(history, "기다린다");
    expect(req.messages).toEqual([{ role: "user", content: "숨는다\n\n기다린다" }]);
  });

  it("최근 턴만 남긴다", () => {
    const history: ChatTurn[] = Array.from({ length: MAX_HISTORY_TURNS + 10 }, (_, i) => ({
      role: i % 2 === 0 ? "player" : "gm",
      text: `턴 ${i}`,
    }));
    const req = buildNarrationRequest(history, "마지막");
    const total = req.messages.length;
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_TURNS + 1);
    expect(req.messages[0]?.role).toBe("user");
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "마지막" });
  });

  it("빈 입력과 너무 긴 입력을 거부한다", () => {
    expect(() => buildNarrationRequest([], "   ")).toThrow(InvalidPlayerInputError);
    expect(() => buildNarrationRequest([], "가".repeat(MAX_INPUT_LENGTH + 1))).toThrow(
      InvalidPlayerInputError,
    );
  });
});

describe("narrate", () => {
  it("모델이 내보낸 이벤트를 그대로 흘려보낸다", async () => {
    let received: NarrationRequest | undefined;
    const fake: NarrationModel = async function* (request) {
      received = request;
      yield { type: "text", text: "바람이 " };
      yield { type: "text", text: "분다." };
      yield { type: "done", stopReason: "end" };
    };

    const events: NarrationEvent[] = [];
    for await (const event of narrate(fake, [], "밖을 본다")) events.push(event);

    expect(received?.messages).toEqual([{ role: "user", content: "밖을 본다" }]);
    expect(events).toEqual([
      { type: "text", text: "바람이 " },
      { type: "text", text: "분다." },
      { type: "done", stopReason: "end" },
    ]);
  });
});
