/**
 * 임베딩 (기획서 11.4). 모델은 "구현"이 아니라 "사용"한다.
 * core는 이 인터페이스만 알고, 구현체는 바꿀 수 있다 (로컬 bge-m3, 나중에 Voyage AI 등).
 */
export interface Embedder {
  /** 모델 식별자. 저장소에 함께 기록하고, 바뀌면 다시 임베딩한다 */
  readonly id: string;
  readonly dimensions: number;
  /** 정규화된 벡터 (코사인 유사도 = 내적) */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * 테스트용 결정적 임베더: 글자 3-gram을 해시해 차원에 더한다.
 * 의미는 모르지만 겹치는 글자가 많을수록 가깝다. 모델을 내려받지 않고 RAG 파이프라인을 시험할 때 쓴다.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  constructor(readonly dimensions = 128) {
    this.id = `hash-trigram-${dimensions}`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(this.dimensions);
      const s = text.replace(/\s+/g, " ");
      for (let i = 0; i + 3 <= s.length; i++) {
        let h = 2166136261;
        for (const ch of s.slice(i, i + 3)) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
        v[(h >>> 0) % this.dimensions]! += 1;
      }
      return normalize(v);
    });
  }
}

export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}
