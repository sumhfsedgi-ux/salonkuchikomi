"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import PillSelect from "@/components/ui/PillSelect";
import Skeleton from "@/components/ui/Skeleton";
import StarRating from "@/components/ui/StarRating";
import EmptyState from "@/components/ui/EmptyState";
import ReviewListItem from "@/components/reviews/inbox/ReviewListItem";
import { InboxContext, type InboxContextValue } from "@/components/reviews/inbox/InboxContext";
import { formatCheckedAt } from "@/lib/googleReviews/format";
import { DEFAULT_LIST_QUERY, FILTER_LABELS, INBOX_PATH, listQueryString, parseListQuery, reviewDetailPath, withQuery } from "@/lib/googleReviews/query";
import { ATTENTION_FILTER_NOTE, matchesFilter } from "@/lib/googleReviews/replyState";
import { CONNECTION_CHANGED_MESSAGE } from "@/lib/googleReviews/messages";
import { shouldReloadAfterAutoRefresh, shouldShowRefreshError } from "@/lib/googleReviews/autoRefresh";
import type {
  InboxSummary,
  RefreshResult,
  ReviewFilter,
  ReviewListQuery,
  ReviewListResult,
  ReviewRatingFilter,
  ReviewSort,
  ReviewSummary,
} from "@/lib/googleReviews/types";

// 届いた口コミの一覧と詳細(計画 第2版 §2「届いた口コミの画面」)。上から
//   ① 新着のお知らせ(1件以上のときだけ。初回の取り込みが終わるまでは出さない)
//   ② 数字(Google の値:口コミ数・平均評価。取得できていなければ「—」。0 とは表示しない)
//   ③ 最終更新と［更新］(新しい口コミは、画面を開いたときと［更新］を押したときに取り込む。リアルタイムに見える言い方をしない)。
//      数字が Google の値であることと取得の時刻は、ここにまとめて1回だけ出す
//   ④ 絞り込み(未返信(既定)／確認が必要／返信済み／すべて、評価、並び順)。PC では1行、スマホでは折り返す
//   ⑤ 一覧(領域の幅が 848px 以上なら右に詳細)
// 未返信の件数は出さない(Google の規定との関係が未確認のため保留。計画 第2版 §7-1)。
// この部品は layout に置くので、詳細へ移っても一覧(読み込み済みのページ・絞り込み・選択)はそのまま残る。
// 更新のたびに画面全体を Skeleton に戻さない。Skeleton は最初の読み込みと、絞り込みを変えたときだけ。
// 画面を開いたとき(ほかの画面から来た・再読み込み・詳細の URL を直接開いた)に、［更新］と同じ処理を1回だけ呼ぶ。
// 一覧と詳細の行き来・絞り込み・並び順の変更では呼ばない(この部品は作り直されない)。5分の間隔と取得中の重複はサーバーが止める。

const TWO_COLUMN_MIN_PX = 848;
const SLOW_SYNC_MS = 30_000;

const RATING_OPTIONS: { value: ReviewRatingFilter; label: string }[] = [
  { value: "all", label: "すべての評価" },
  { value: "5", label: "★5" },
  { value: "4", label: "★4" },
  { value: "3", label: "★3" },
  { value: "low", label: "★1〜2" },
];
const SORT_OPTIONS: { value: ReviewSort; label: string }[] = [
  { value: "newest", label: "新しい順" },
  { value: "lowest", label: "低評価順" },
];

type ListState =
  | { status: "loading" }
  | { status: "initial_sync"; since: number }
  | { status: "error"; message: string }
  | { status: "not_connected" }
  | { status: "ready"; items: ReviewSummary[]; nextCursor: string | null; noReviewsAtAll: boolean };

function toListState(result: ReviewListResult): ListState {
  switch (result.kind) {
    case "ok":
      return { status: "ready", items: result.items, nextCursor: result.nextCursor, noReviewsAtAll: result.noReviewsAtAll };
    case "initial_sync":
      return { status: "initial_sync", since: Date.now() };
    case "error":
      return { status: "error", message: result.message };
    case "not_connected":
      return { status: "not_connected" };
  }
}

function summaryOf(result: ReviewListResult): InboxSummary | null {
  return result.kind === "ok" || result.kind === "initial_sync" ? result.summary : null;
}

interface Props {
  initialResult: ReviewListResult;
  actions: {
    list: (query: ReviewListQuery, cursor: string | null) => Promise<ReviewListResult>;
    refresh: () => Promise<RefreshResult>;
  };
  children: ReactNode;
  basePath?: string;
}

const selectClass =
  "min-h-11 rounded-lg border border-greige bg-white px-3 text-sm text-ink focus:border-sage focus:outline-none focus-visible:ring-2 focus-visible:ring-sage/40";

function StatCard({ label, children, note }: { label: string; children: ReactNode; note: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-white p-3">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex min-h-6 flex-wrap items-center gap-2 text-ink">{children}</div>
      {note && <span className="text-xs text-ink-muted">{note}</span>}
    </div>
  );
}

export default function ReviewsInbox({ initialResult, actions, children, basePath = INBOX_PATH }: Props) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const searchParams = useSearchParams();
  const query = useMemo(() => parseListQuery(searchParams), [searchParams]);
  const queryKey = listQueryString(query);

  const selectedId = typeof params.id === "string" ? decodeURIComponent(params.id) : null;
  const showingDetail = selectedId !== null;

  const isInitialQuery = queryKey === listQueryString(DEFAULT_LIST_QUERY);
  const [list, setList] = useState<ListState>(() => (isInitialQuery ? toListState(initialResult) : { status: "loading" }));
  const [summary, setSummary] = useState<InboxSummary | null>(summaryOf(initialResult));
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [slowSync, setSlowSync] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const [twoColumn, setTwoColumn] = useState(false);
  const requestSeq = useRef(0);
  const moreSeq = useRef(0);
  const autoRefreshed = useRef(false);
  const loadedKey = useRef<string | null>(isInitialQuery ? queryKey : null);
  const savedScroll = useRef<number | null>(null);
  const lastSelected = useRef<string | null>(null);
  const openedFromList = useRef(false);
  const filterLabelId = useId();

  // 2列か1列か(CSS の container query と同じ条件)。
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setTwoColumn(width >= TWO_COLUMN_MIN_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** 一覧の結果を反映する。違う世代(連携・店舗が変わった)の結果なら、画面を読み直す(古い世代の行を混ぜない)。 */
  const applyResult = useCallback(
    (result: ReviewListResult, mode: "replace" | "keep_on_error") => {
      const nextSummary = summaryOf(result);
      if (nextSummary && summary && nextSummary.locationId !== summary.locationId) {
        router.refresh();
        return;
      }
      if (mode === "keep_on_error" && result.kind === "error") return;
      setList(toListState(result));
      if (nextSummary) setSummary(nextSummary);
      if (result.kind === "not_connected") router.refresh();
    },
    [router, summary],
  );

  const load = useCallback(
    async (target: ReviewListQuery) => {
      const seq = ++requestSeq.current;
      setList({ status: "loading" });
      setMoreError(null);
      let result: ReviewListResult;
      try {
        result = await actions.list(target, null);
      } catch {
        result = { kind: "error", message: "口コミを読み込めませんでした。" };
      }
      if (seq !== requestSeq.current) return; // 古い応答は捨てる
      applyResult(result, "replace");
    },
    [actions, applyResult],
  );

  // 絞り込み・並び順が変わったら読み直す(最初の表示は layout で読んだ結果を使う)。
  useEffect(() => {
    if (loadedKey.current === queryKey) return;
    loadedKey.current = queryKey;
    void load(query);
  }, [queryKey, query, load]);

  // 初回の取得が30秒を超えたら、時間がかかっていることを出す。
  useEffect(() => {
    if (list.status !== "initial_sync") return;
    const timer = setTimeout(() => setSlowSync(true), Math.max(0, SLOW_SYNC_MS - (Date.now() - list.since)));
    return () => {
      clearTimeout(timer);
      setSlowSync(false);
    };
  }, [list]);

  // 1列のとき:一覧に戻ったらスクロール位置と、開いていた行へのフォーカスを戻す。詳細を開いたら先頭へ。
  useEffect(() => {
    if (twoColumn) return;
    if (showingDetail) {
      window.scrollTo(0, 0);
      return;
    }
    const id = lastSelected.current;
    const top = savedScroll.current;
    if (id === null) return;
    requestAnimationFrame(() => {
      if (top !== null) window.scrollTo(0, top);
      const link = rootRef.current?.querySelector<HTMLAnchorElement>(`[data-review-id="${CSS.escape(id)}"]`);
      link?.focus({ preventScroll: true });
    });
  }, [showingDetail, twoColumn]);

  function setQuery(next: Partial<ReviewListQuery>) {
    const merged = { ...query, ...next };
    const base = selectedId ? `${basePath}/${encodeURIComponent(selectedId)}` : basePath;
    router.replace(withQuery(base, merged), { scroll: false });
  }

  function onSelect(id: string) {
    lastSelected.current = id;
    openedFromList.current = true;
    if (!twoColumn) savedScroll.current = window.scrollY;
  }

  async function loadMore() {
    if (list.status !== "ready" || !list.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const seq = requestSeq.current;
    let result: ReviewListResult;
    try {
      result = await actions.list(query, list.nextCursor);
    } catch {
      result = { kind: "error", message: "続きを読み込めませんでした。" };
    }
    setLoadingMore(false);
    if (seq !== requestSeq.current) return;
    if (result.kind !== "ok") {
      setMoreError("続きを読み込めませんでした。もう一度お試しください。");
      return;
    }
    if (summary && result.summary.locationId !== summary.locationId) {
      router.refresh();
      return;
    }
    moreSeq.current++;
    setList((prev) =>
      prev.status === "ready"
        ? {
            ...prev,
            items: [...prev.items, ...result.items.filter((item) => !prev.items.some((p) => p.id === item.id))],
            nextCursor: result.nextCursor,
          }
        : prev,
    );
  }

  function refresh() {
    void runRefresh(false);
  }

  /** auto:画面を開いたときの自動の取り込み。一時的な失敗は出さず、表示中の一覧を入れ替えるのは何も変わっていないときだけ。 */
  async function runRefresh(auto: boolean) {
    if (refreshing) return;
    setRefreshing(true);
    if (!auto) setRefreshError(null);
    const startSeq = requestSeq.current;
    const startMore = moreSeq.current;
    let result: RefreshResult;
    try {
      result = await actions.refresh();
    } catch {
      result = { ok: false, error: "最新の口コミを取得できませんでした。", temporary: true };
    }
    if (!result.ok) {
      setRefreshing(false);
      if (shouldShowRefreshError(result, auto)) setRefreshError(result.error);
      return;
    }
    const listChanged = () => requestSeq.current !== startSeq || moreSeq.current !== startMore;
    if (auto && !shouldReloadAfterAutoRefresh({ shownLastCheckedAt: summary?.lastCheckedAt ?? null, lastCheckedAt: result.value.lastCheckedAt, listChanged: listChanged() })) {
      setRefreshing(false);
      return;
    }
    // 一覧は残したまま入れ替える(Skeleton に戻さない)。初回の取得中なら、取り込めた分を表示に切り替える。
    const seq = ++requestSeq.current;
    const next = await actions.list(query, null).catch((): ReviewListResult => ({ kind: "error", message: "" }));
    setRefreshing(false);
    if (seq === requestSeq.current && !(auto && moreSeq.current !== startMore)) applyResult(next, "keep_on_error");
  }

  // 画面を開いたときに1回だけ取り込む(［更新］と同じ処理)。一覧と詳細の行き来では、この部品は作り直されない。
  useEffect(() => {
    if (autoRefreshed.current) return;
    autoRefreshed.current = true;
    void runRefresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 最初の表示のときに1回だけ行う
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<ReviewSummary>) => {
    setList((prev) =>
      prev.status === "ready" ? { ...prev, items: prev.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : prev,
    );
    // 開いた新着は、新着の数から外す(サーバーの数え方と同じ:開いたら新着ではない)。
    if (patch.isNew === false) {
      setSummary((prev) => (prev && prev.newCount ? { ...prev, newCount: Math.max(0, prev.newCount - 1) } : prev));
    }
  }, []);

  const nextUnrepliedHref = useCallback(
    (currentId: string) => {
      if (list.status !== "ready") return null;
      const at = list.items.findIndex((item) => item.id === currentId);
      const ordered = at >= 0 ? [...list.items.slice(at + 1), ...list.items.slice(0, at)] : list.items;
      const next = ordered.find((item) => item.id !== currentId && matchesFilter(item, "unreplied"));
      return next ? reviewDetailPath(next.id, query, basePath) : null;
    },
    [list, query, basePath],
  );

  const contextValue = useMemo<InboxContextValue>(
    () => ({
      basePath,
      query,
      twoColumn,
      updateItem,
      cameFromList: () => openedFromList.current,
      nextUnrepliedHref,
      locationId: summary?.locationId ?? null,
    }),
    [basePath, query, twoColumn, updateItem, nextUnrepliedHref, summary?.locationId],
  );

  const lastChecked = summary?.lastCheckedAt ? formatCheckedAt(summary.lastCheckedAt) : null;
  const ratingAt = summary?.ratingAt ? formatCheckedAt(summary.ratingAt) : null;
  const newCount = summary?.initialSyncDone ? summary.newCount : null;
  const filterOptions: { value: ReviewFilter; label: string }[] = [
    ...FILTER_LABELS,
    ...(query.filter === "new" || (newCount ?? 0) > 0 ? [{ value: "new" as const, label: "新着" }] : []),
  ];

  const header = (
    <div className={cn("flex-col gap-3", showingDetail ? "hidden @min-[53rem]:flex" : "flex")}>
      {newCount !== null && newCount > 0 && query.filter !== "new" && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-sage/30 bg-sage-soft p-3 text-sm text-sage-dark sm:flex-row sm:items-center sm:justify-between"
        >
          <span>
            <span className="font-semibold">新しい口コミが{newCount}件あります</span>
            <span className="block text-xs text-ink-muted">画面を開いたときや［更新］で見つかった口コミのうち、まだ開いていないものです。</span>
          </span>
          <Button type="button" size="sm" onClick={() => setQuery({ filter: "new" })} className="shrink-0">
            新着を見る
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3 @min-[53rem]:flex-row @min-[53rem]:items-stretch">
        <div className="grid flex-1 grid-cols-2 gap-3 @min-[53rem]:max-w-md">
          <StatCard label="口コミ数" note={summary?.totalReviewCount != null ? null : "更新すると表示されます"}>
            <span className="text-lg font-semibold">{summary?.totalReviewCount != null ? `${summary.totalReviewCount}件` : "—"}</span>
          </StatCard>
          <StatCard label="平均評価" note={summary?.averageRating != null ? null : "更新すると表示されます"}>
            {summary?.averageRating != null ? (
              <>
                <span className="text-lg font-semibold">{summary.averageRating.toFixed(1)}</span>
                <StarRating value={summary.averageRating} size="md" />
              </>
            ) : (
              <span className="text-lg font-semibold">—</span>
            )}
          </StatCard>
        </div>
        <div className="flex flex-col gap-1 @min-[53rem]:ml-auto @min-[53rem]:items-end @min-[53rem]:justify-center">
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted" role="status" aria-live="polite">
              {lastChecked ? `最終更新 ${lastChecked}` : "まだ更新していません"}
              {refreshing ? "・更新中…" : ""}
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={refreshing}>
              更新
            </Button>
          </div>
          <p className="text-xs text-ink-muted @min-[53rem]:text-right">
            {summary?.totalReviewCount != null || summary?.averageRating != null
              ? `口コミ数・平均評価はGoogle上の値です${ratingAt && ratingAt !== lastChecked ? `(${ratingAt}時点)` : ""}。`
              : ""}
            画面を開いたときと［更新］で取り込みます。
          </p>
        </div>
      </div>

      {summary?.contentExpired && !summary.syncIncomplete && !refreshError && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-3 text-sm text-ink sm:flex-row sm:items-center sm:justify-between"
        >
          <span>Googleの口コミは、一時保存の期限(25日)を過ぎると表示から外しています。［更新］で、Googleから最新の内容を取り直します。</span>
          <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={refreshing} className="shrink-0">
            {refreshing ? "取り直しています…" : "取り直す"}
          </Button>
        </div>
      )}
      {summary?.syncIncomplete && !refreshError && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-3 text-sm text-ink sm:flex-row sm:items-center sm:justify-between"
        >
          <span>口コミが多いため、Googleからの取得を途中で区切っています。古い口コミは、続きを取得すると表示されます。</span>
          <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={refreshing} className="shrink-0">
            {refreshing ? "取得しています…" : "続きを取得する"}
          </Button>
        </div>
      )}
      {refreshError && (
        <Alert variant="warning" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>
            {refreshError}
            {lastChecked ? `(最終更新 ${lastChecked})` : ""}
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={refreshing}>
            もう一度試す
          </Button>
        </Alert>
      )}
    </div>
  );

  let body: ReactNode;
  if (list.status === "loading") {
    body = (
      <ul className="flex flex-col divide-y divide-border" aria-label="読み込み中">
        {[0, 1, 2, 3].map((n) => (
          <li key={n} className="flex gap-3 px-3 py-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-full" />
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (list.status === "initial_sync") {
    body = (
      <div className="flex flex-col gap-3 p-3">
        <p className="text-sm text-ink-muted" role="status">
          Googleから口コミを取得しています。終わると、ここに表示されます。
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={refresh} disabled={refreshing} className="self-start">
          {refreshing ? "取得しています…" : slowSync ? "時間がかかっています。もう一度試す" : "取得の状況を確認する"}
        </Button>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (list.status === "error") {
    body = (
      <div className="p-3">
        <Alert variant="error" className="flex flex-col gap-2">
          <span>{list.message || "口コミを読み込めませんでした。"}</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => void load(query)} className="self-start">
            もう一度試す
          </Button>
        </Alert>
      </div>
    );
  } else if (list.status === "not_connected") {
    body = (
      <div className="p-3">
        <EmptyState
          title="口コミを表示できません"
          description={CONNECTION_CHANGED_MESSAGE}
          actions={
            <Button type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>
              一覧を読み込み直す
            </Button>
          }
        />
      </div>
    );
  } else if (list.items.length === 0) {
    const isDefaultView = query.filter === DEFAULT_LIST_QUERY.filter && query.rating === "all";
    body = (
      <div className="p-3">
        {list.noReviewsAtAll ? (
          <EmptyState
            title="まだGoogle口コミはありません"
            description="口コミが届くと、画面を開いたときや［更新］で取り込み、ここに表示されます。"
            actions={
              <Link href="/dashboard/reviews" className="text-sm font-medium text-sage-dark underline underline-offset-2">
                アンケートで口コミを集める ›
              </Link>
            }
          />
        ) : isDefaultView ? (
          <EmptyState
            title="未返信の口コミはありません"
            actions={
              <Button type="button" size="sm" variant="secondary" onClick={() => setQuery({ filter: "all" })}>
                すべて表示
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="この条件の口コミはありません"
            actions={
              <Button type="button" size="sm" variant="secondary" onClick={() => setQuery(DEFAULT_LIST_QUERY)}>
                条件をクリア
              </Button>
            }
          />
        )}
      </div>
    );
  } else {
    body = (
      <>
        <ul className="flex flex-col divide-y divide-border">
          {list.items.map((review) => (
            <ReviewListItem
              key={review.id}
              review={review}
              query={query}
              selected={review.id === selectedId}
              onSelect={onSelect}
              basePath={basePath}
            />
          ))}
        </ul>
        {(list.nextCursor || moreError) && (
          <div className="flex flex-col gap-2 border-t border-border p-3">
            {moreError && <Alert variant="error">{moreError}</Alert>}
            {list.nextCursor && (
              <Button type="button" variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "読み込んでいます…" : "さらに読み込む"}
              </Button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <InboxContext.Provider value={contextValue}>
      <div ref={rootRef} className="@container flex flex-col gap-4">
        {header}
        <div className={cn("flex-col gap-2", showingDetail ? "hidden @min-[53rem]:flex" : "flex")}>
          <div className="flex flex-col gap-2 @min-[53rem]:flex-row @min-[53rem]:items-center @min-[53rem]:justify-between">
            <span id={filterLabelId} className="sr-only">
              返信の状態で絞り込む
            </span>
            <div role="group" aria-labelledby={filterLabelId}>
              <PillSelect options={filterOptions} value={query.filter} onChange={(v) => setQuery({ filter: v })} />
            </div>
            <div className="flex gap-2 @min-[53rem]:shrink-0">
              <select
                aria-label="評価で絞り込む"
                className={cn(selectClass, "min-w-0 flex-1 @min-[53rem]:w-40 @min-[53rem]:flex-none")}
                value={query.rating}
                onChange={(e) => setQuery({ rating: e.target.value as ReviewRatingFilter })}
              >
                {RATING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="並び順(新しい順は投稿日の新しい順)"
                className={cn(selectClass, "min-w-0 flex-1 @min-[53rem]:w-36 @min-[53rem]:flex-none")}
                value={query.sort}
                onChange={(e) => setQuery({ sort: e.target.value as ReviewSort })}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {query.filter === "attention" && <p className="text-xs text-ink-muted">{ATTENTION_FILTER_NOTE}</p>}
        </div>
        <div className="grid gap-6 @min-[53rem]:grid-cols-[340px_minmax(0,1fr)] @min-[53rem]:items-start">
          <section
            aria-label="口コミの一覧"
            className={cn(
              "flex flex-col gap-3",
              showingDetail ? "hidden @min-[53rem]:flex" : "flex",
              "@min-[53rem]:sticky @min-[53rem]:top-6",
            )}
          >
            <Card className="relative overflow-hidden p-0 @min-[53rem]:max-h-[calc(100dvh-6rem)] @min-[53rem]:overflow-y-auto">{body}</Card>
          </section>
          <div className={cn("min-w-0", showingDetail ? "block" : "hidden @min-[53rem]:block")}>{children}</div>
        </div>
      </div>
    </InboxContext.Provider>
  );
}
