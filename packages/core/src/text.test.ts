import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fill, josa, sentence } from "./text.ts";

describe("조사", () => {
  it("받침에 맞춰 고른다", () => {
    expect(josa("강태호", "이/가")).toBe("강태호가");
    expect(josa("박만수", "은/는")).toBe("박만수는");
    expect(josa("윤채원", "이/가")).toBe("윤채원이");
    expect(josa("분대장", "으로/로")).toBe("분대장으로");
    expect(josa("분대원", "으로/로")).toBe("분대원으로");
    expect(josa("밤", "으로/로")).toBe("밤으로");
    expect(josa("저녁", "으로/로")).toBe("저녁으로");
    expect(josa("새벽", "으로/로")).toBe("새벽으로");
    expect(josa("낮", "으로/로")).toBe("낮으로");
    expect(josa("아침", "으로/로")).toBe("아침으로");
    expect(josa("서울", "으로/로")).toBe("서울로");
  });

  it("닫는 따옴표 뒤면 그 앞 글자로 고른다", () => {
    expect(josa(`"염철구"`, "이/가")).toBe(`"염철구"가`);
    expect(josa(`"윤채원"`, "을/를")).toBe(`"윤채원"을`);
  });

  it("한글로 끝나지 않으면 둘 다 적는다", () => {
    expect(josa("a_taeho", "은/는")).toBe("a_taeho은(는)");
  });

  it("영문 대문자·숫자는 읽는 소리로 고른다", () => {
    expect(josa("세력 C", "이/가")).toBe("세력 C가");
    expect(josa("세력 A", "을/를")).toBe("세력 A를");
    expect(josa("세력 L", "은/는")).toBe("세력 L은");
    expect(josa("3", "이/가")).toBe("3이");
    expect(josa("강변 공장 지대", "이라는/라는")).toBe("강변 공장 지대라는");
    expect(josa("빈 땅", "이라는/라는")).toBe("빈 땅이라는");
  });

  it("틀 문장을 채운다", () => {
    expect(fill("{a:이/가} {z:을/를} 습격했다. 사상자 {n}", { a: "세력 C", z: "동쪽 초소", n: "한두 명" })).toBe(
      "세력 C가 동쪽 초소를 습격했다. 사상자 한두 명",
    );
    expect(fill("{missing}", {})).toBe("{missing}");
  });

  it("마침표를 하나로 맞춘다", () => {
    expect(sentence("통조림을 챙겼다.")).toBe("통조림을 챙겼다.");
    expect(sentence("통조림을 챙겼다")).toBe("통조림을 챙겼다.");
  });
});

describe("날것 조사 막기 (PT14)", () => {
  it("끝에 붙은 괄호 풀이(id)는 건너뛰고 읽는다: 강태호(a_taeho)가", () => {
    expect(josa("강태호(a_taeho)", "이/가")).toBe("강태호(a_taeho)가");
    expect(josa("윤채원 (a_chaewon)", "은/는")).toBe("윤채원 (a_chaewon)은");
    expect(josa("하얀매", "이/가")).toBe("하얀매가");
  });

  it("코드·콘텐츠에 \"이(가)\", \"을(를)\", \"은(는)\" 같은 날것 조사를 쓰지 않는다 (josa로 고른다)", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const walk = (dir: string, ext: RegExp): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "dist") return [];
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p, ext) : ext.test(name) && !name.includes(".test.") ? [p] : [];
      });
    const files = [
      ...walk(join(root, "packages/core/src"), /\.ts$/),
      ...walk(join(root, "packages/mcp/src"), /\.ts$/),
      ...walk(join(root, "packages/ui/src"), /\.tsx?$/),
      ...walk(join(root, "content/scenarios"), /\.(ya?ml|md)$/),
    ];
    const raw = /(이\(가\)|가\(이\)|을\(를\)|를\(을\)|은\(는\)|는\(은\)|과\(와\)|와\(과\))/;
    const out: string[] = [];
    for (const f of files) {
      // text.ts는 읽는 법을 모르는 글자(id)에 둘 다 적는 josa 자신이다
      if (f.endsWith("packages/core/src/text.ts")) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (raw.test(line)) out.push(`${relative(root, f)}:${i + 1}`);
      });
    }
    expect(out).toEqual([]);
  });
});
