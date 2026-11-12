import { describe, expect, it } from "vitest";
import { fill, josa, sentence } from "./text.ts";

describe("조사", () => {
  it("받침에 맞춰 고른다", () => {
    expect(josa("강태호", "이/가")).toBe("강태호가");
    expect(josa("박만수", "은/는")).toBe("박만수는");
    expect(josa("윤채원", "이/가")).toBe("윤채원이");
    expect(josa("분대장", "으로/로")).toBe("분대장으로");
    expect(josa("하급 전투원", "으로/로")).toBe("하급 전투원으로");
    expect(josa("밤", "으로/로")).toBe("밤으로");
    expect(josa("저녁", "으로/로")).toBe("저녁으로");
    expect(josa("새벽", "으로/로")).toBe("새벽으로");
    expect(josa("낮", "으로/로")).toBe("낮으로");
    expect(josa("아침", "으로/로")).toBe("아침으로");
    expect(josa("서울", "으로/로")).toBe("서울로");
  });

  it("한글로 끝나지 않으면 둘 다 적는다", () => {
    expect(josa("a_taeho", "은/는")).toBe("a_taeho은(는)");
  });

  it("영문 대문자·숫자는 읽는 소리로 고른다", () => {
    expect(josa("세력 C", "이/가")).toBe("세력 C가");
    expect(josa("세력 A", "을/를")).toBe("세력 A를");
    expect(josa("세력 L", "은/는")).toBe("세력 L은");
    expect(josa("3", "이/가")).toBe("3이");
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
