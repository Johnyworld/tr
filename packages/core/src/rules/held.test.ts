import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { heldOf, HELD_PAUSES, pausedWhileHeld, playerHeld } from "./held.ts";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return name.endsWith(".ts") && !name.includes(".test.") ? [p] : [];
  });
}

/** 갇힘을 직접 다뤄도 되는 곳: 세이브 기록(리듀서), 캐릭터 스키마, 이 규칙 모듈 */
const ALLOWED = new Set(["game/state.ts", "game/character.ts", "rules/held.ts"]);

describe("공통 규칙 1: 갇힘", () => {
  it("갇혀 있는지는 rules/held.ts로만 읽는다 (기능마다 따로 검사하다 하나씩 빠졌다, 플레이 테스트 12·13)", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // 이야기 배역의 조건(role.captive)은 콘텐츠 필드라 괜찮다
          if (/\.captive\b/.test(line.replace(/role\.captive\b/g, ""))) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("갇힌 기록과 멈추는 셈", () => {
    const held = { by: "f", zone: "z" };
    const state = { playerId: "p", characters: { p: { captive: held }, q: { captive: null } } };
    expect(heldOf(state.characters.p)).toBe(held);
    expect(heldOf(state.characters.q)).toBeNull();
    expect(playerHeld(state)).toBe(held);
    for (const what of HELD_PAUSES) expect(pausedWhileHeld(state, what)).toBe(true);
    expect(pausedWhileHeld({ ...state, playerId: "q" }, "mission")).toBe(false);
  });
});
