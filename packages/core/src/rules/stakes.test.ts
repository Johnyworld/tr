import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { atStake, type StakeFacts } from "./stakes.ts";

const SRC = join(import.meta.dirname, "..");
const none: StakeFacts = { harm: false, opponent: false, mission: false, storyChoice: false, battle: false, treatment: false, travel: "none", exposed: false, gathering: false, activity: false };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return name.endsWith(".ts") && !name.includes(".test.") ? [p] : [];
  });
}

describe("공통 규칙 6: 걸린 판정", () => {
  it("아무것도 걸리지 않은 판정은 걸린 판정이 아니다", () => {
    expect(atStake(none).stake).toBe(false);
  });

  it("빈 땅으로 옮겨 가며 건 판정은 걸린 판정이 아니고, 적 땅을 드나들면 걸린 판정이다 (플레이 테스트 13)", () => {
    expect(atStake({ ...none, travel: "safe" }).stake).toBe(false);
    expect(atStake({ ...none, travel: "hostile" })).toEqual({ stake: true, why: ["적 땅 드나들기"] });
  });

  it("무엇이 걸렸는지 까닭을 함께 돌려준다", () => {
    expect(atStake({ ...none, harm: true, mission: true }).why).toEqual(["위험", "임무"]);
  });

  it("판정을 굴리는 곳은 stakes를 atStake로만 정한다", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // atStake·stakesOf(규칙 6의 함수)로만. 판정 함수의 인자 모양(stakes: boolean)은 빼고 (12-269: stakes를 꼭 넘기게 했다)
          if (/\bstakes:(?!\s*(atStake|stakesOf)\()/.test(line) && !/stakes\??:\s*boolean/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
