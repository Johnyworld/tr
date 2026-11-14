import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content/loader.ts";
import { createSeededRng } from "../rng.ts";
import { WorldManager } from "../world/manager.ts";

/** 메모 (12-75): 메모장과 펜·연필이 있으면 적고, 메모장만 있으면 읽기만 */
const content = loadContent(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../content/scenarios/post_apoc"));
const open = () => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-memo-")), content, rngFactory: () => createSeededRng(1) }).create("mcp", "role_a_grunt");

describe("메모", () => {
  it("메모장과 펜이 있어야 적고, 탭(view.memo)도 그때만 열린다", async () => {
    const w = open();
    expect(w.playerView().memo).toBeNull();
    expect(w.setMemo("a").ok).toBe(false);
    expect(await w.runCommand("?메모")).toContain("메모장이 없습니다");
    w.runCheat("~give notebook");
    expect(w.playerView().memo).toBeNull(); // 펜이 없다
    expect(await w.runCommand("?메모")).toContain("읽기만");
    w.runCheat("~give pencil");
    expect(w.playerView().memo).toEqual({ text: "" });
    w.close();
  });

  it("?메모로 덧붙이고, 고치고, 지운다. 화면은 통째로 바꾼다. 시간이 흐르지 않는다", async () => {
    const w = open();
    w.runCheat("~give notebook");
    w.runCheat("~give pen");
    const t0 = w.state().time;
    expect(w.memoCommand("?메모 강태호는 장터를 싫어한다")).toContain("적었습니다");
    w.memoCommand("?메모 오지호에게 빚 2");
    expect(w.playerView().memo?.text).toBe("강태호는 장터를 싫어한다\n오지호에게 빚 2");
    expect(w.memoCommand("?메모 고침 새로 적음")).toContain("고쳤습니다");
    expect(w.playerView().memo?.text).toBe("새로 적음");
    expect(w.setMemo("화면에서 적음\n둘째 줄").ok).toBe(true);
    expect(await w.runCommand("?메모")).toContain("둘째 줄");
    expect(w.memoCommand("?메모 지움")).toContain("지웠습니다");
    expect(w.playerView().memo?.text).toBe("");
    expect(w.memoCommand("?메모")).toBeNull(); // 읽기는 runCommand
    expect(w.memoCommand("?상태")).toBeNull();
    expect(w.setMemo("x".repeat(4001)).ok).toBe(false);
    expect(w.state().time).toBe(t0);
    w.close();
  });
});
