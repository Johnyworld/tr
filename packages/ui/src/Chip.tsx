import type { HTMLAttributes } from "react";

/**
 * 작은 이름표 (아는 것의 출처, 행적의 태그, 장비 자리, 판정 보정). 회색 바탕에 글자는 바탕색으로 뒤집는다 (styles.css .chip-tag).
 * tone "danger": 빨간 바탕 (판정 보정처럼 경고인 것).
 * 눌러서 고르는 칩(설정 창의 .chip)은 이것이 아니다
 */
export function Chip({ tone = "default", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: "default" | "danger" }) {
  const cls = ["chip-tag", tone !== "default" && tone, className].filter(Boolean).join(" ");
  return <span className={cls} {...rest} />;
}
