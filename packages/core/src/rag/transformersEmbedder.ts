import type { Embedder } from "./embedder.ts";

/**
 * 로컬 bge-m3 임베더 (transformers.js, ONNX). 키가 필요 없고 다국어를 지원한다.
 * 첫 사용 때 모델(양자화 q8, 약 570MB)을 cacheDir에 내려받는다.
 * 무거운 의존성이라 실제로 쓸 때만 불러온다 (테스트는 HashEmbedder를 쓴다).
 */
export class BgeM3Embedder implements Embedder {
  readonly id = "Xenova/bge-m3:q8:cls";
  readonly dimensions = 1024;
  #extract: Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(private readonly options: { cacheDir: string; batchSize?: number }) {}

  #pipeline() {
    this.#extract ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.options.cacheDir;
      const extract = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "q8" });
      return extract as unknown as (texts: string[], options: object) => Promise<{ tolist(): number[][] }>;
    })();
    return this.#extract;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extract = await this.#pipeline();
    const batch = this.options.batchSize ?? 16;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batch) {
      // bge-m3 dense 임베딩: CLS 풀링 + 정규화
      const result = await extract(texts.slice(i, i + batch), { pooling: "cls", normalize: true });
      for (const row of result.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  }
}
