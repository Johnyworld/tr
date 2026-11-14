import { useEffect, useRef, useState } from "react";

/** 적고 나서 이만큼 멈추면 저장한다 */
const SAVE_DELAY_MS = 700;
const MAX_LENGTH = 4000;

/**
 * 메모 탭 (12-75): 메모장과 펜·연필이 있을 때 플레이어가 적는 곳. 테두리 없는 글 칸(contenteditable)에 바로 적고,
 * 멈추면 세이브에 저장한다 (규칙은 core GameWorld.setMemo). 채팅의 ?메모로 바뀌면 적고 있지 않을 때 따라간다
 */
export function MemoPanel({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "error">("saved");
  const [length, setLength] = useState(text.length);

  // 바깥(채팅의 ?메모)에서 바뀐 메모: 적고 있지 않을 때만 받는다 (적는 중인 글을 덮지 않게)
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el || timer.current) return;
    if (el.innerText !== text) el.innerText = text;
    setLength(text.length);
  }, [text]);

  const save = async () => {
    timer.current = null;
    const value = (ref.current?.innerText ?? "").replace(/\n$/, "");
    setState("saving");
    try {
      const res = await fetch("/api/memo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: value }) });
      setState(res.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
  };

  const onInput = () => {
    setLength(ref.current?.innerText.length ?? 0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  // 탭을 떠나도 적던 것은 저장한다
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void save();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <section className="memo">
      <div
        ref={ref}
        className="memo-editor"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="메모"
        data-placeholder="여기에 적으세요. 메모장과 펜(또는 연필)이 있는 동안 적을 수 있습니다."
        onInput={onInput}
        onBlur={() => {
          if (timer.current) {
            clearTimeout(timer.current);
            void save();
          }
        }}
      />
      <div className={length > MAX_LENGTH ? "memo-status over" : "memo-status"}>
        <span>{state === "saving" ? "저장 중…" : state === "error" ? "저장하지 못했습니다" : "저장됨"}</span>
        <span>
          {length}/{MAX_LENGTH}
        </span>
      </div>
    </section>
  );
}
