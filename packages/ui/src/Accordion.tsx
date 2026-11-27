import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 접는 칸. 머리를 누르면 접고 편다. 칸의 높이만 움직이고 내용은 제 크기 그대로 가려진다.
 * - variant "card": HUD의 상자 (같이 있는 인물, 퀘스트). 상자 전체가 누르는 곳이고, meta(머리 오른쪽)·peek(접혔을 때 한 줄)·empty(점선)를 쓴다
 * - variant "plain": 시트의 접는 섹션(관계, 인물 사이, 내 행적, 아는 것). 머리만 누르는 곳이고, 모양은 그 자리의 CSS로
 * id를 주면 접힘 상태를 칸마다 브라우저에 기억한다
 */
export function Accordion({
  id,
  title,
  variant = "plain",
  meta,
  peek,
  empty = false,
  defaultOpen = true,
  className,
  children,
}: {
  /** 접힘 기억 키. 없으면 기억하지 않는다 */
  id?: string;
  /** 머리. card는 작은 이름표 글자, plain은 그대로 (시트 섹션은 <h3>) */
  title: ReactNode;
  variant?: "card" | "plain";
  /** card: 머리 줄 오른쪽에 늘 보이는 것 (기한, 인원) */
  meta?: ReactNode;
  /** card: 접혔을 때 머리 아래 한 줄 (임무 이름, 인물 이름) */
  peek?: ReactNode;
  /** card: 내용이 없을 때 (점선 테두리) */
  empty?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // HUD 칸이 쓰던 키를 그대로 쓴다 (이미 접어 둔 것이 풀리지 않게)
  const key = id ? `trpg.hud.${id}` : null;
  const [open, setOpen] = useState(() => {
    if (!key) return defaultOpen;
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v !== "closed";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      if (key) {
        try {
          localStorage.setItem(key, o ? "closed" : "open");
        } catch {
          // 저장이 막혀 있으면 이번만
        }
      }
      return !o;
    });
  };
  const bodyId = useId();
  // 지금 보이는 층(펼친 내용 / 한 줄 요약, 없으면 0)의 실제 높이로 칸의 높이를 바꾼다
  const peekRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<{ peek: number; body: number } | null>(null);
  const hasPeek = !!peek;
  useLayoutEffect(() => {
    const measure = () => setHeights({ peek: peekRef.current?.offsetHeight ?? 0, body: bodyRef.current?.offsetHeight ?? 0 });
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [peekRef.current, bodyRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
    // 한 줄 요약이 생기거나 사라지면 다시 붙인다
  }, [hasPeek]);
  const height = heights ? (open ? heights.body : heights.peek) : undefined;
  const card = variant === "card";
  const swap = (
    <div className="hud-swap" style={height === undefined ? undefined : { height }}>
      {peek && (
        <div ref={peekRef} className={open ? "hud-layer hud-panel-peek" : "hud-layer hud-panel-peek shown"} aria-hidden={open}>
          {peek}
        </div>
      )}
      <div ref={bodyRef} id={bodyId} className={open ? `hud-layer ${card ? "hud-panel-body " : ""}shown` : `hud-layer${card ? " hud-panel-body" : ""}`} aria-hidden={!open}>
        {children}
      </div>
    </div>
  );
  if (card) {
    return (
      // 상자 전체가 누르는 곳이다 (머리 단추의 클릭·키보드도 여기로 올라온다)
      <section className={["hud-panel", empty && "empty", open && "open", className].filter(Boolean).join(" ")} onClick={toggle}>
        <button type="button" className="hud-panel-head" aria-expanded={open} aria-controls={bodyId}>
          <span className="hud-panel-label">{title}</span>
          {meta && <span className="hud-panel-meta">{meta}</span>}
          <span className="hud-panel-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
        {swap}
      </section>
    );
  }
  return (
    <div className={["fold", open && "open", className].filter(Boolean).join(" ")}>
      <button type="button" className="fold-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        {title}
        <span className="fold-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {swap}
    </div>
  );
}
