"use client";

import { useLayoutEffect, useRef } from "react";

// Grows a textarea's height to fit its content so long question/option text
// wraps and stays fully visible, instead of being clipped at a fixed
// single-line width (as happens with <input> on narrow screens like
// in-app browsers).
export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return ref;
}

// Textareas otherwise insert a newline on Enter — question/option text is
// meant to stay a single logical line that just wraps, so Enter should
// behave like it does in a plain <input> (do nothing) rather than break
// the line.
export function blockEnterKey(e: React.KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
  }
}
