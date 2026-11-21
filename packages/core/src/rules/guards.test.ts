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

  it("치료 (engine/care/slots.ts): 오늘 돌봄을 받았는지는 care/slots.ts로만 읽는다", () => {
    expect(offenders(/\b(lastHealerDay|lastAidDay|healerSnap|aidSnap)\b/, ["game/state.ts", "engine/care/slots.ts"])).toEqual([]);
  });

  it("규칙 10 (남의 물건): 빌린 장비·맡은 짐은 rules/entrusted.ts로만 읽는다", () => {
    expect(offenders(/\b(state|getState\(\)|next|s)\??\.(loans|cargo)\b/, ["game/state.ts", "rules/entrusted.ts"])).toEqual([]);
  });

  it("규칙 11 (우리 땅): 땅 주인이 그 무리인지는 rules/home.ts로만 묻는다", () => {
    expect(offenders(/\.zones\[[^\]]*\]\??\.owner\s*(===|!==)/, ["game/state.ts", "rules/home.ts", "sim/war.ts"])).toEqual([]);
  });

  it("규칙 12 (판정과 스킬): 배운 값은 rules/skill.ts로만 읽는다", () => {
    expect(offenders(/\blearnedSkill\(/, ["scenario/scenario.ts", "rules/skill.ts"])).toEqual([]);
  });

  it("규칙 13 (피해의 셈): 버팀과 방어구는 rules/damage.ts로만 셈한다", () => {
    expect(offenders(/\b(resistSteps|armorAbsorb)\(/, ["engine/growth.ts", "engine/gear.ts", "rules/damage.ts"])).toEqual([]);
  });

  it("규칙 14 (소식이 닿는 길): 우리 일이면 소식, 남의 일이면 소문은 rules/news.ts로만 정한다", () => {
    expect(offenders(/\?\s*"report"\s*:\s*"rumor"/, ["rules/news.ts"])).toEqual([]);
  });

  it("규칙 15 (장소): 지금 장소와 즉흥 장소는 rules/place.ts로만 읽는다", () => {
    expect(offenders(/\.(playerPlace|spawnedPlaces)\b/, ["game/state.ts", "rules/place.ts"])).toEqual([]);
  });

  it("규칙 15 (장소): 인물의 구역은 rules/place.ts의 whereIs로만 묻는다", () => {
    expect(offenders(/\bnpcZoneAt\(/, ["game/whereabouts.ts", "rules/place.ts"])).toEqual([]);
  });

  it("규칙 16 (자기다움): 설정 굴림과 비밀을 아는 사람은 rules/self.ts로만 읽는다", () => {
    expect(offenders(/\.(settingRolls|secretKnownBy)\b/, ["game/state.ts", "rules/self.ts"])).toEqual([]);
  });

  it("규칙 16 (자기다움): 성격 굴림은 rules/self.ts를 거친다", () => {
    expect(offenders(/from "\.\/persona\.ts".*roll(Blowup|Hear|Leak)|roll(Blowup|Hear|Leak).*from "\.\/persona\.ts"/, ["rules/self.ts"])).toEqual([]);
  });

  it("규칙 7 (본 대로): 주인공이 본 땅 주인은 rules/knowledge.ts로만 읽는다", () => {
    expect(offenders(/\bzoneSeen\b/, ["game/state.ts", "rules/knowledge.ts"])).toEqual([]);
  });
});
