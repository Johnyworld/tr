import type { ButtonHTMLAttributes } from "react";

/**
 * 상태 화면의 일반 단추. 모양은 styles.css의 .btn (판 색 배경, 그림자).
 * 고르기 칸(카드·칩·탭·스테퍼)은 이것을 쓰지 않는다.
 * - variant: default / primary(새로운 게임과 같은 색) / danger(빨간 바탕, 되돌릴 수 없는 확인) / remove(흐린 글자, 올리면 빨강: 휴지통·게임 종료)
 * - size: xs(줄 안의 작은 아이콘) / sm / md(기본) / lg(메인 메뉴·시작)
 * - icon: 글자 없이 아이콘만 (네모에 가깝게), block: 폭 전체
 */
export type ButtonVariant = "default" | "primary" | "danger" | "remove";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export function Button({
  variant = "default",
  size = "md",
  icon,
  block,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; block?: boolean }) {
  const cls = ["btn", `btn-${size}`, variant !== "default" && `btn-${variant}`, icon && "btn-icon", block && "btn-block", className].filter(Boolean).join(" ");
  return <button type={type} className={cls} {...rest} />;
}
