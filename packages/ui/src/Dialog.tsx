import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";

/**
 * 상태 화면의 공용 창 (팝오버·확인 창).
 * - Popover: 누른 것 옆에 뜨는 작은 창. 바깥을 누르거나 Esc면 닫힌다 (장비 벗기, 얼굴 고르기, 설정)
 * - ConfirmPopover: Popover 위의 예/아니요
 * - ConfirmDialog: 화면 가운데의 확인 창 (뒤를 어둡게). 되돌릴 수 없는 일 앞에서 묻는다
 * 단추 순서는 모두 [취소] [확인]
 */

/**
 * 열려 있는 동안 boundary 바깥을 누르거나 Esc를 누르면 onClose.
 * 확인 창(.confirm-backdrop) 안을 누른 것은 바깥으로 치지 않는다 (팝오버에서 연 확인 창)
 */
export function useDismiss(boundary: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (boundary.current?.contains(target) || target.closest?.(".confirm-backdrop")) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, boundary]);
}

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** 누르면 닫히지 않는 영역 (여는 단추를 감싼 것). 없으면 팝오버 자신 */
  boundary?: RefObject<HTMLElement | null>;
  /** 화면 읽기 프로그램에 읽히는 이름 */
  label: string;
  /** 자리: 기본은 여는 것 바로 아래 왼쪽 맞춤 (부모가 position: relative). 다른 자리는 className·style로 */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

/** 팝오버. 안을 누른 것은 부모(여는 단추)로 번지지 않는다 */
export function Popover({ open, onClose, boundary, label, className, style, children }: PopoverProps) {
  const own = useRef<HTMLDivElement>(null);
  useDismiss(boundary ?? own, open, onClose);
  if (!open) return null;
  return (
    <div
      ref={own}
      className={className ? `popover ${className}` : "popover"}
      role="dialog"
      aria-label={label}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** 팝오버의 예/아니요 */
export function ConfirmPopover({
  question,
  note,
  confirmLabel = "예",
  cancelLabel = "아니요",
  busy,
  onConfirm,
  ...popover
}: Omit<PopoverProps, "children" | "label"> & {
  question: ReactNode;
  /** 질문 아래 작은 설명 */
  note?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  label?: string;
}) {
  return (
    <Popover {...popover} label={popover.label ?? (typeof question === "string" ? question : confirmLabel)}>
      <p className="popover-q">{question}</p>
      {note && <p className="muted small">{note}</p>}
      <div className="popover-actions">
        <button type="button" onClick={popover.onClose}>
          {cancelLabel}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Popover>
  );
}

/** 확인 창. 배경을 누르거나 Esc면 취소. 처음 초점은 취소 단추 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "취소",
  danger = true,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 확인 단추를 빨갛게 (되돌릴 수 없는 일) */
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
        {error && <p className="settings-error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} autoFocus disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
