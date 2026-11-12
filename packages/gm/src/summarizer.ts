import Anthropic from "@anthropic-ai/sdk";

/** 여러 턴의 서술을 장면 요약 하나로 줄인다 (기획서 11.3: 요약은 작은 모델) */
export type Summarizer = (narrations: string[], options?: { signal?: AbortSignal }) => Promise<string>;

export const DEFAULT_SUMMARY_MODEL = "claude-haiku-5-5";

const SYSTEM = `너는 TRPG 기록 담당이다. 여러 턴의 GM 서술을 받아 다음 세션의 GM이 이어 갈 수 있게 장면 요약을 쓴다.
- 한국어, 3~5문장. 2인칭("당신은")으로 쓴다.
- 플레이어 캐릭터가 한 일, 만난 인물, 바뀐 상황, 남은 긴장(해결되지 않은 일)을 담는다.
- 서술에 없는 사실을 지어내지 않는다. 숫자를 새로 만들지 않는다.
- 요약만 쓰고 다른 말은 하지 않는다.`;

export function createClaudeSummarizer(options: { client?: Anthropic; model?: string } = {}): Summarizer {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_SUMMARY_MODEL;
  return async (narrations, callOptions) => {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 2000,
        output_config: { effort: "low" },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: narrations.map((text, i) => `<턴 ${i + 1}>\n${text}\n</턴 ${i + 1}>`).join("\n\n"),
          },
        ],
      },
      { signal: callOptions?.signal },
    );
    if (response.stop_reason === "refusal") throw new Error("요약 모델이 요약을 거절했습니다.");
    return response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
  };
}
