/** 플레이어 입력 검증 (두 모드 공통) */

/** 플레이어 한 번의 입력 최대 길이 (문자 수) */
export const MAX_INPUT_LENGTH = 2000;

export class InvalidPlayerInputError extends Error {
  override name = "InvalidPlayerInputError";
}

export function normalizePlayerInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidPlayerInputError("입력이 비어 있습니다.");
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new InvalidPlayerInputError(`입력은 ${MAX_INPUT_LENGTH}자 이하여야 합니다.`);
  }
  return trimmed;
}
