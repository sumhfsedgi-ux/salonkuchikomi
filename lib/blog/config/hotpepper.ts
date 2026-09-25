// Hot Pepper Beautyからの過去ブログ取り込み・Style Profile生成のチューニング値。
// lib/blog/hotpepper/scraper.ts, app/dashboard/blog/settings/style-profile/actions.ts から参照する。
// (blog-appの config/hotpepper.ts を無変更で移植)

export const HOTPEPPER_HOSTNAME = "beauty.hotpepper.jp";

// 一覧・個別記事ページのパス検証に使う正規表現。
// 実サイト確認により、"/kr/slnXXXX/blog/" のように2文字の言語/地域プレフィックスが
// 付くURLパターンも存在することを確認済みのため、プレフィックスはオプショナルで許容する。
// キャプチャグループは位置ベース（tsconfigのtarget=ES2017では名前付きキャプチャグループが
// 使えないため）。match[1]=言語/地域プレフィックス(あれば)、match[2]=サロンパス。
export const HOTPEPPER_BLOG_LIST_PATH_RE =
  /^\/(?:([a-z]{2})\/)?(sln[0-9A-Za-z]+)\/blog\/(?:PN\d+\.html)?$/;
export const HOTPEPPER_BLOG_ARTICLE_PATH_RE =
  /^\/(?:[a-z]{2}\/)?sln[0-9A-Za-z]+\/blog\/bid[0-9A-Za-z]+\.html$/;

export const HOTPEPPER_IMPORT_MAX_POSTS = 30;
export const HOTPEPPER_IMPORT_MAX_PAGES = 6;
export const HOTPEPPER_IMPORT_TOTAL_BUDGET_MS = 45_000;
export const HOTPEPPER_REQUEST_TIMEOUT_MS = 8_000;
export const HOTPEPPER_REQUEST_INTERVAL_MS = 500;

// 正直な自己申告のUser-Agent（ブラウザへの偽装はしない）。
export const HOTPEPPER_USER_AGENT = "salonpack-internal-importer/1.0 (internal tool for salon's own blog archive)";

export const MIN_STYLE_PROFILE_POSTS = 3;
export const MAX_STYLE_PROFILE_SOURCE_POSTS = 15;
export const STYLE_PROFILE_SOURCE_BODY_TRUNCATE = 3000;

// Stage2に渡す参考記事の抜粋の長さと件数（「文章のテンポが分かる長さ」を意図した値）。
export const REFERENCE_POST_EXCERPT_MAX_CHARS = 800;
export const REFERENCE_POSTS_IN_STAGE2_COUNT = 3;
