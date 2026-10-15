"use client";

import { useEffect, useRef } from "react";

// <img> の読み込み失敗を確実に拾う。サーバーで描画した画像は、React が動き出す(hydration)より前に
// 読み込みに失敗することがあり、そのときは onError が呼ばれない。そこで、表示の後にも
// 「読み込みが終わっているのに幅が0」(失敗)かを確かめて onFail を呼ぶ。
export function useImageFailure<T extends HTMLImageElement>(onFail: () => void, enabled = true) {
  const ref = useRef<T>(null);
  const onFailRef = useRef(onFail);

  useEffect(() => {
    onFailRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    const img = ref.current;
    if (!enabled || !img) return;
    if (img.complete && img.naturalWidth === 0) onFailRef.current();
  }, [enabled]);

  return ref;
}
