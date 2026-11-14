import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * HUD의 접는 칸 (임무, 같이 있는 인물). 머리 줄을 누르면 접고 편다.
 * meta: 머리 줄 오른쪽에 늘 보이는 것 (기한, 인원). peek: 접혔을 때 머리 아래 한 줄 (임무 이름, 인물 이름).
 * 접힘 상태는 칸마다 브라우저에 기억한다
 */
export function HudPanel({
  id,
  label,
  meta,
  peek,
  empty = false,
  children,
}: {
  id: string;
  label: string;
  meta?: ReactNode;
  peek?: ReactNode;
  /** 내용이 없을 때 (점선 테두리) */
  empty?: boolean;
  children: ReactNode;
}) {
  const key = `trpg.hud.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        // 저장이 막혀 있으면 이번만
      }
      return !o;
    });
  };
  const bodyId = `hud-panel-${id}`;
  // 칸의 높이만 움직인다: 지금 보이는 층(펼친 내용 / 한 줄 요약)의 실제 높이로 바꾸고, 내용은 제 크기 그대로 overflow로 가린다
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
  return (
    // 칸 전체가 누르는 곳이다 (머리 단추의 클릭·키보드도 여기로 올라온다)
    <section className={`hud-panel${empty ? " empty" : ""}${open ? " open" : ""}`} onClick={toggle}>
      <button type="button" className="hud-panel-head" aria-expanded={open} aria-controls={bodyId}>
        <span className="hud-panel-label">{label}</span>
        {meta && <span className="hud-panel-meta">{meta}</span>}
        <span className="hud-panel-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="hud-swap" style={height === undefined ? undefined : { height }}>
        {peek && (
          <div ref={peekRef} className={open ? "hud-layer hud-panel-peek" : "hud-layer hud-panel-peek shown"} aria-hidden={open}>
            {peek}
          </div>
        )}
        <div ref={bodyRef} id={bodyId} className={open ? "hud-layer hud-panel-body shown" : "hud-layer hud-panel-body"} aria-hidden={!open}>
          {children}
        </div>
      </div>
    </section>
  );
}
