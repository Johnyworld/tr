import { describe, expect, it } from "vitest";
import type { NarrationModel } from "@trpg/core";
import { createApp } from "./app.ts";

const fakeModel: NarrationModel = async function* () {
  yield { type: "text", text: "총성이 " };
  yield { type: "text", text: "멎었다." };
  yield { type: "done", stopReason: "end" };
};

function post(body: unknown) {
  return createApp(fakeModel).request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat", () => {
  it("서술을 SSE로 스트리밍한다", async () => {
    const res = await post({ history: [], input: "귀를 기울인다" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('event: text\ndata: {"type":"text","text":"총성이 "}');
    expect(body).toContain('event: done\ndata: {"type":"done","stopReason":"end"}');
  });

  it("빈 입력은 400을 돌려준다", async () => {
    const res = await post({ history: [], input: "  " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "입력이 비어 있습니다." });
  });

  it("형식이 틀린 요청은 400을 돌려준다", async () => {
    const res = await post({ history: [{ role: "system", text: "x" }], input: "a" });
    expect(res.status).toBe(400);
  });
});
