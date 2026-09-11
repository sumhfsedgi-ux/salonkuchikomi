// Hot Pepper Beautyの公開ブログページ（サロン自身が投稿した過去記事）を取得するモジュール。
// DBには依存しない（呼び出し元がparse結果を保存する）。
//
// セキュリティ上の注意: この関数群はユーザーが入力したURL、および取得したページ内に
// 含まれるリンク（rel="next"、個別記事へのリンク）をサーバー側からfetchする。
// beauty.hotpepper.jp 以外のホストへは絶対にリクエストしない多層防御を行っている
// （SSRF対策。validateHotPepperBlogUrlとresolveHotPepperUrlの両方でホスト名を検証する）。
//
// 利用規約が「クローリング」を明示的に禁止も許可もしていないグレーな状態であることを
// 踏まえ、節度あるアクセス（低頻度・件数上限・正直なUser-Agent・robots.txt尊重）で実装する。
// (blog-appの lib/hotpepper/scraper.ts を無変更で移植、import pathのみ更新)

import * as cheerio from "cheerio";
import {
  HOTPEPPER_HOSTNAME,
  HOTPEPPER_BLOG_LIST_PATH_RE,
  HOTPEPPER_BLOG_ARTICLE_PATH_RE,
  HOTPEPPER_IMPORT_MAX_POSTS,
  HOTPEPPER_IMPORT_MAX_PAGES,
  HOTPEPPER_IMPORT_TOTAL_BUDGET_MS,
  HOTPEPPER_REQUEST_TIMEOUT_MS,
  HOTPEPPER_REQUEST_INTERVAL_MS,
  HOTPEPPER_USER_AGENT,
} from "@/lib/blog/config/hotpepper";

type CheerioAPI = ReturnType<typeof cheerio.load>;

export class HotPepperFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: "robots_disallowed" | "network_error" | "http_error" | "timeout" | "parse_error"
  ) {
    super(message);
    this.name = "HotPepperFetchError";
  }
}

export interface HotPepperUrlValidation {
  ok: boolean;
  normalizedUrl?: string;
  salonPath?: string;
  reason?: string;
}

export interface NewReferencePostInput {
  sourceUrl: string;
  title: string;
  body: string;
  authorName: string | null;
  postedAt: string | null;
}

export interface HotPepperImportResult {
  newPosts: NewReferencePostInput[];
  skippedExisting: number;
  failed: number;
  totalFoundOnSite: number | null;
  stoppedEarly: boolean;
}

// ---------------------------------------------------------------------------
// URL検証（SSRF対策の要。入力時とページ内リンク追跡時の両方で使う多層防御）
// ---------------------------------------------------------------------------

export function validateHotPepperBlogUrl(rawUrl: string): HotPepperUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "URLの形式が正しくありません。" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "https:// で始まるURLを入力してください。" };
  }
  // .includes()や.endsWith()は "beauty.hotpepper.jp.evil.com" のようなバイパスを
  // 許してしまうため使わない。完全一致のみを信頼する。
  if (url.hostname !== HOTPEPPER_HOSTNAME) {
    return { ok: false, reason: `${HOTPEPPER_HOSTNAME} のURLを入力してください。` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLの形式が正しくありません。" };
  }

  const match = url.pathname.match(HOTPEPPER_BLOG_LIST_PATH_RE);
  if (!match) {
    return {
      ok: false,
      reason:
        "サロンのブログ一覧ページのURL（例: https://beauty.hotpepper.jp/slnXXXXXXX/blog/）を入力してください。",
    };
  }

  const [, prefix, salonPath] = match;
  // 検証通過後、パースした部品からURLを再構築する（生の入力文字列をそのまま使わない
  // ＝クエリ文字列やエンコーディングトリックの混入を避ける）。常にページ1の一覧URLに正規化する。
  const normalizedUrl = `https://${HOTPEPPER_HOSTNAME}${prefix ? `/${prefix}` : ""}/${salonPath}/blog/`;
  return { ok: true, normalizedUrl, salonPath };
}

/** 取得したページ内のリンク(href)を、同一オリジン・想定パスの場合のみ絶対URLとして解決する。 */
function resolveHotPepperUrl(href: string, base: string, pathPattern: RegExp): string | null {
  let resolved: URL;
  try {
    resolved = new URL(href, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" || resolved.hostname !== HOTPEPPER_HOSTNAME) return null;
  if (!pathPattern.test(resolved.pathname)) return null;
  return resolved.toString();
}

// ---------------------------------------------------------------------------
// robots.txt（軽量な自前チェック。ユーザーは事前に人力確認済みという前提だが、
// サイト側の変更に備えて実行のたびに再確認する）
// ---------------------------------------------------------------------------

function isPathDisallowedForAnyAgent(robotsTxt: string, path: string): boolean {
  let inWildcardGroup = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "user-agent") {
      inWildcardGroup = value === "*";
      continue;
    }
    if (key === "disallow" && inWildcardGroup && value && path.startsWith(value)) {
      return true;
    }
  }
  return false;
}

async function isBlogPathDisallowedByRobots(): Promise<boolean> {
  try {
    const res = await fetch(`https://${HOTPEPPER_HOSTNAME}/robots.txt`, {
      cache: "no-store",
      headers: { "User-Agent": HOTPEPPER_USER_AGENT },
      signal: AbortSignal.timeout(HOTPEPPER_REQUEST_TIMEOUT_MS),
    });
    // 取得失敗はブロックしない（フェイルオープン。既にユーザーが目視確認済みという前提を優先）。
    if (!res.ok) return false;
    const text = await res.text();
    return isPathDisallowedForAnyAgent(text, "/blog/");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ページ取得
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHotPepperPage(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      // 正規のブログページがリダイレクトを要求する理由はない。
      // リダイレクトは疑わしいシグナルとして扱い、黙って追従しない。
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": HOTPEPPER_USER_AGENT },
      signal: AbortSignal.timeout(HOTPEPPER_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new HotPepperFetchError(
      isTimeout ? "取得がタイムアウトしました。" : "ネットワークエラーが発生しました。",
      isTimeout ? "timeout" : "network_error"
    );
  }

  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new HotPepperFetchError("想定しないリダイレクトが発生しました。", "http_error");
  }
  if (!res.ok) {
    throw new HotPepperFetchError(`ページの取得に失敗しました（status ${res.status}）。`, "http_error");
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// 一覧ページの解析
// ---------------------------------------------------------------------------

interface ListedItem {
  sourceUrl: string;
  title: string;
  authorName: string | null;
  postedAt: string | null;
}

interface ParsedListingPage {
  items: ListedItem[];
  nextUrl: string | null;
  totalFoundOnSite: number | null;
}

function parseHotPepperDate(text: string): string | null {
  const match = text.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const [, y, mo, d] = match;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00+09:00`;
}

function normalizeAuthorName(text: string): string | null {
  const normalized = text.replace(/[\s　]+/g, " ").trim();
  return normalized || null;
}

function parseListingPage($: CheerioAPI, baseUrl: string): ParsedListingPage {
  const totalText = $(".numberOfResult").first().text().trim();
  const totalFoundOnSite = totalText ? Number.parseInt(totalText, 10) : null;

  const items: ListedItem[] = [];
  $("li.blogListCassette").each((_, el) => {
    const li = $(el);
    const titleAnchor = li.find(".blogListTtl a").first();
    const title = titleAnchor.text().trim();
    const hrefRaw = titleAnchor.attr("href");
    if (!title || !hrefRaw) return;

    const sourceUrl = resolveHotPepperUrl(hrefRaw, baseUrl, HOTPEPPER_BLOG_ARTICLE_PATH_RE);
    if (!sourceUrl) return;

    const dateDd = li
      .find("dt")
      .filter((_i, dt) => $(dt).text().includes("投稿日"))
      .first()
      .next("dd");
    const postedAt = parseHotPepperDate(dateDd.text());

    const authorDd = li
      .find("dt")
      .filter((_i, dt) => $(dt).text().includes("投稿者"))
      .first()
      .next("dd");
    const authorAnchorText = authorDd.find("a").first().text();
    const authorName = normalizeAuthorName(authorAnchorText || authorDd.text());

    items.push({ sourceUrl, title, authorName, postedAt });
  });

  const nextHref = $('head link[rel="next"]').attr("href");
  const nextUrl = nextHref ? resolveHotPepperUrl(nextHref, baseUrl, HOTPEPPER_BLOG_LIST_PATH_RE) : null;

  return { items, nextUrl, totalFoundOnSite };
}

// ---------------------------------------------------------------------------
// 個別記事ページの解析（本文抽出。<br>を改行として保持することが文体分析上重要）
// ---------------------------------------------------------------------------

function extractArticleBody($: CheerioAPI): string | null {
  const dd = $("#jsiBlogContents .blogDtlWrap dl.blogDtlInner dd").first();
  if (dd.length === 0) return null;

  // <br> は改行として保持し、画像・スクリプト等の非テキスト要素は除去する。
  dd.find("br").replaceWith("\n");
  dd.find("img, script, style, iframe").remove();

  // <ul>/<ol>の箇条書き記号・番号はCSSで見た目上表示されているだけでテキストには
  // 残らないため、このままでは通常の段落と区別がつかなくなる。Style Profileの
  // 箇条書き分析が機能するよう、プレーンテキスト化前に明示的な記号を書き戻す。
  dd.find("ol").each((_i, ol) => {
    $(ol)
      .children("li")
      .each((liIndex, li) => {
        $(li).prepend(`${liIndex + 1}. `);
      });
  });
  dd.find("ul").each((_i, ul) => {
    $(ul)
      .children("li")
      .each((_liIndex, li) => {
        $(li).prepend("・");
      });
  });

  // div/p/li等のブロック要素の後ろにも改行を補う（段落構造の再現）。
  dd.find("div, p, li").each((_i, el) => {
    $(el).append("\n");
  });

  const raw = dd.text();
  const normalized = raw
    .replace(/[ ]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized || null;
}

// ---------------------------------------------------------------------------
// オーケストレーション
// ---------------------------------------------------------------------------

export async function importHotPepperBlogPosts(
  normalizedUrl: string,
  opts: { existingSourceUrls: Set<string> }
): Promise<HotPepperImportResult> {
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > HOTPEPPER_IMPORT_TOTAL_BUDGET_MS;

  if (await isBlogPathDisallowedByRobots()) {
    throw new HotPepperFetchError(
      "robots.txtによりこのページの取得が禁止されています。",
      "robots_disallowed"
    );
  }

  // --- フェーズ1: 一覧ページを辿って記事メタ情報を収集 ---
  const listedItems: ListedItem[] = [];
  let totalFoundOnSite: number | null = null;
  let stoppedEarly = false;
  let nextUrl: string | null = normalizedUrl;
  let pageCount = 0;

  while (nextUrl && listedItems.length < HOTPEPPER_IMPORT_MAX_POSTS) {
    if (pageCount >= HOTPEPPER_IMPORT_MAX_PAGES || budgetExceeded()) {
      stoppedEarly = true;
      break;
    }
    if (pageCount > 0) await sleep(HOTPEPPER_REQUEST_INTERVAL_MS);

    let html: string;
    try {
      html = await fetchHotPepperPage(nextUrl);
    } catch (err) {
      // 1ページ目の取得失敗はインポート全体の失敗として扱う。2ページ目以降は
      // それまでの収集結果を使って打ち切る（1件の失敗で全体を無駄にしない）。
      if (pageCount === 0) throw err;
      stoppedEarly = true;
      break;
    }
    pageCount++;

    const $ = cheerio.load(html);
    const parsed = parseListingPage($, nextUrl);
    if (totalFoundOnSite === null) totalFoundOnSite = parsed.totalFoundOnSite;

    if (parsed.items.length === 0 && (parsed.totalFoundOnSite ?? 0) > 0) {
      throw new HotPepperFetchError(
        "ブログ記事一覧のページ構造を認識できませんでした。サイトの仕様が変更された可能性があります。",
        "parse_error"
      );
    }

    listedItems.push(...parsed.items);
    nextUrl = parsed.nextUrl;
  }

  // --- フェーズ2: 個別記事ページを取得して本文を補完（重複取得はスキップ） ---
  const targetItems = listedItems.slice(0, HOTPEPPER_IMPORT_MAX_POSTS);
  const newPosts: NewReferencePostInput[] = [];
  let skippedExisting = 0;
  let failed = 0;

  for (const item of targetItems) {
    if (opts.existingSourceUrls.has(item.sourceUrl)) {
      skippedExisting++;
      continue;
    }
    if (budgetExceeded()) {
      stoppedEarly = true;
      break;
    }
    await sleep(HOTPEPPER_REQUEST_INTERVAL_MS);

    try {
      const html = await fetchHotPepperPage(item.sourceUrl);
      const $ = cheerio.load(html);
      const body = extractArticleBody($);
      if (!body) {
        failed++;
        continue;
      }
      newPosts.push({
        sourceUrl: item.sourceUrl,
        title: item.title,
        body,
        authorName: item.authorName,
        postedAt: item.postedAt,
      });
    } catch {
      // 個別記事1件の失敗はスキップして続行する。
      failed++;
    }
  }

  return { newPosts, skippedExisting, failed, totalFoundOnSite, stoppedEarly };
}
