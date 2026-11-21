import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 공통 규칙을 건너뛰지 못하게 (docs/design.md "공통 규칙"): 규칙이 다루는 상태는 그 규칙 모듈과 세이브 기록(리듀서)만 읽는다.
 * 새 기능이 이 상태를 직접 읽어야 하면 규칙 모듈에 함수를 더한다
 */
const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return name.endsWith(".ts") && !name.includes(".test.") ? [p] : [];
  });
}

function offenders(pattern: RegExp, allowed: string[]): string[] {
  const out: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).replaceAll("\\", "/");
    if (allowed.includes(rel)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) out.push(`${rel}:${i + 1}`);
      });
  }
  return out;
}

describe("공통 규칙을 건너뛰지 않는다", () => {
  it("규칙 1·2 (갇힘·탓할 수 없는 일): 풀려난 시각은 rules/held.ts·rules/blame.ts로만 읽는다", () => {
    expect(offenders(/\.lastFreedAt\b/, ["game/state.ts", "rules/blame.ts", "rules/held.ts"])).toEqual([]);
  });

  it("규칙 7 (본 대로): 주인공이 본 땅 주인은 rules/knowledge.ts로만 읽는다", () => {
    expect(offenders(/\bzoneSeen\b/, ["game/state.ts", "rules/knowledge.ts"])).toEqual([]);
  });
});
