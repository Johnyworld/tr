import type { Embedder } from "./embedder.ts";
import { RagIndex, type SearchHit, type SearchOptions, type SearchTrace, type Viewer } from "./index.ts";
import { readLoreDocs } from "./lore.ts";

export type LoreSearch = { hits: SearchHit[]; trace: SearchTrace | null; error?: string };

/**
 * 시나리오의 lore 컬렉션. 색인을 열고 lore 파일과 맞추는 일(모델 로딩·임베딩)을 백그라운드로 시작한다.
 * 준비가 끝나기 전의 검색은 준비를 기다린다. 준비에 실패하면 빈 결과와 이유를 돌려준다 (게임은 계속된다).
 */
export class LoreLibrary {
  #index: Promise<RagIndex | null>;
  #error: string | null = null;

  constructor(index: Promise<RagIndex | null>) {
    this.#index = index.catch((err: unknown) => {
      this.#error = err instanceof Error ? err.message : String(err);
      return null;
    });
  }

  /** 색인을 열고 lore 폴더와 동기화한다 (바뀐 파일만 다시 임베딩) */
  static open(options: { indexPath: string; loreDir: string; embedder: Embedder; log?: (message: string) => void }): LoreLibrary {
    const log = options.log ?? ((m: string) => console.error(m));
    return new LoreLibrary(
      (async () => {
        const index = RagIndex.open(options.indexPath, options.embedder);
        const report = await index.sync(readLoreDocs(options.loreDir));
        log(
          `[rag] lore 색인 준비됨: 청크 ${index.count()}개 (추가 ${report.added}, 변경 ${report.updated}, 삭제 ${report.removed}, 그대로 ${report.unchanged}, 임베딩 ${report.chunks}) · ${options.embedder.id}`,
        );
        return index;
      })(),
    );
  }

  /** 이미 준비된 색인으로 만든다 (테스트용) */
  static fromIndex(index: RagIndex): LoreLibrary {
    return new LoreLibrary(Promise.resolve(index));
  }

  async search(query: string, viewer: Viewer, options?: SearchOptions): Promise<LoreSearch> {
    const index = await this.#index;
    if (!index) return { hits: [], trace: null, error: `lore 색인을 쓸 수 없다: ${this.#error ?? "알 수 없는 이유"}` };
    return index.search(query, viewer, options);
  }

  async close() {
    (await this.#index)?.close();
  }
}

/** GM에게 넘길 참고 자료 블록. 청크 머리([문서 > 절])를 그대로 둔다 */
export function formatLoreHits(hits: readonly SearchHit[]): string {
  return hits.map((h) => h.text).join("\n\n");
}
