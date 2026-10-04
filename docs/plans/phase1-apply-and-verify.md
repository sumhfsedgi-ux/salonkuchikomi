# Phase 1（口コミ生成 v2）適用・確認手順

PLAN（docs/plans/reviews-465-plan.md §13）の Phase 1 の、本番への出し方と確認方法。
**migration の本番DBへの適用は、master に取り込んでから運営者が行う**（DB を master より先に変えない）。

## 含まれる変更
| 種類 | 内容 | 本番への影響（REVIEW_PIPELINE 未設定 = v1 のとき） |
|---|---|---|
| アプリ | 口コミ生成 v2（`lib/reviewGeneration/`、`lib/ai/naturalJapanese/`） | なし（`REVIEW_PIPELINE=v2` にするまで使われない） |
| アプリ | `/api/generate-review`：回答を DB のアンケートと照合する。店舗名・業種は DB の値を使う。ログに回答・本文を出さない | v1 の生成結果は変わらない。アンケートと合わない回答は 409（ページの再読み込みを案内） |
| アプリ | レート制限（IP＋店舗で10分に20回、店舗ごとに1日300回） | 0012 の適用前は、DB のエラーとして**制限せずに通す** |
| アプリ | 生成イベントの記録（メタデータのみ）、CTA クリックの記録（`/api/review-events`） | 0012 の適用前は記録に失敗するだけ（お客様への応答には影響しない。ログに警告が出る） |
| アプリ | お客様ページの文言：「口コミの下書きができました」「アンケートをもとに口コミ文を作成しました。内容を確認して、必要に応じて自由に編集してください。」、CTA「この内容をコピーしてGoogleへ進む」、補足「Googleの口コミ投稿画面が開きます。自動で投稿されることはありません。」 | 文言が変わる |
| DB（要適用） | `supabase/migrations/0012_review_generation_events.sql`：`ai_generation_events`、`rate_limit_buckets`、`rate_limit_hit()` | 新しいテーブルと関数だけ。既存のテーブルは変更しない |

変更していないもの：seed.sql（選択肢は追加しない）、APP_MODE、`lib/notifications/**`、0009 のテーブル、blog の生成処理、hmail。

## 1. リリースの順番
1. Phase 1 を master に取り込み、本番にデプロイする（`REVIEW_PIPELINE` は未設定のまま = v1）。
2. 0012 を本番 Supabase に適用し、§3 の確認をする。
3. オフライン評価（§6）・自動テスト・目視確認・待ち時間・lint の違反率・意味検証の結果を見て、問題なければ Vercel の環境変数に `REVIEW_PIPELINE=v2`、`OPENAI_MODEL_REVIEW_VERIFICATION=gpt-4.1-mini`、`OPENAI_MODEL_REVIEW_REPAIR=gpt-4.1-mini` を設定して再デプロイする。
4. §4 のクエリで様子を見る。問題があれば `REVIEW_PIPELINE` を外して再デプロイすれば、すぐ v1 に戻る。

## 2. migration 0012 の適用
Supabase ダッシュボードの **SQL Editor** に `0012_review_generation_events.sql` の内容を貼り付けて実行する。
- 何度実行しても同じ結果になる（`if not exists` と `create or replace`）。
- 既存のテーブル・データには触れない。

## 3. 適用後の確認（どれもロールバックするので、データは変わらない）
**確認1：テーブルと関数ができている**（3行とも返れば正常）
```sql
select 'ai_generation_events' as name, to_regclass('public.ai_generation_events') is not null as ok
union all select 'rate_limit_buckets', to_regclass('public.rate_limit_buckets') is not null
union all select 'rate_limit_hit', to_regprocedure('public.rate_limit_hit(text,integer,integer)') is not null;
```

**確認2：上限まで true、超えたら false になる**（`true, true, false` の順になれば正常）
```sql
begin;
set local role service_role;
select public.rate_limit_hit('verify:check', 600, 2) as first,
       public.rate_limit_hit('verify:check', 600, 2) as second,
       public.rate_limit_hit('verify:check', 600, 2) as third;
rollback;
```

**確認3：ブラウザ（anon / authenticated）からは関数もテーブルも使えない**（どちらも `ERROR: 42501`（permission denied）になれば正常。ブロックごとに実行する）
```sql
begin;
set local role anon;
select public.rate_limit_hit('verify:anon', 600, 2);
rollback;
```
```sql
begin;
set local role authenticated;
select count(*) from public.ai_generation_events;
rollback;
```

## 4. 本番での確認（v1 のまま・v2 に切り替えたあと）
イベントは本文を含まないので、次のような集計で様子を見る。
```sql
-- 直近24時間の、パイプライン別の件数・失敗率・待ち時間(p95)
select pipeline,
       count(*) filter (where kind in ('generated', 'regenerated')) as generated,
       count(*) filter (where kind = 'failed') as failed,
       percentile_cont(0.95) within group (order by latency_ms)
         filter (where kind in ('generated', 'regenerated')) as p95_latency_ms
from public.ai_generation_events
where created_at > now() - interval '24 hours'
group by pipeline;

-- 指摘コードの件数(v1 と v2 を比べる)
select pipeline, flag, count(*)
from public.ai_generation_events, unnest(lint_flags) as flag
where created_at > now() - interval '7 days' and kind in ('generated', 'regenerated')
group by pipeline, flag
order by pipeline, count(*) desc;

-- v2 の同期検証の該当率と、意味検証の指摘
select verify_mode, count(*), array_agg(distinct f) filter (where f is not null) as flags
from public.ai_generation_events left join lateral unnest(verify_flags) as f on true
where pipeline = 'v2' and created_at > now() - interval '7 days'
group by verify_mode;
```

## 5. 問題があった場合
- **生成の不具合**：Vercel の `REVIEW_PIPELINE` を外して再デプロイする（v1 に戻る。DB は戻さなくてよい）。
- **0012 を取り消す**（イベントの記録とレート制限が止まるだけで、生成は続く）：
```sql
drop function if exists public.rate_limit_hit(text, integer, integer);
drop table if exists public.rate_limit_buckets;
drop table if exists public.ai_generation_events;
```

## 6. オフライン評価の結果（2026-10-04）
`npm run eval:review`（架空の回答36件。そのうち、自由記述・「その他」に否定的な内容を含むもの13件）。下書きの各文は、監査モデル gpt-4.1 が素材と見比べて判定した。

| 指標 | v1（今の本番） | v2（最終の評価） |
|---|---|---|
| 失敗 | 0/36 | 0/36 |
| 待ち時間 p50 / p95 | 1.2秒 / 2.8秒 | 1.7秒 / 3.5秒（v1 の +0.7秒） |
| 回答に無い満足表現などを含む下書き（Linter） | 23/36 | 0/36 |
| 否定的な内容の反映 | 12/13 | 13/13 |
| 監査で問題があった文 | 69/108（64%） | 8/67（12%） |
| 監査で問題があった下書き | 34/36 | 8/36 |
| うち、回答に無い満足表現 | 37 | 0 |
| うち、否定的な内容の反転・弱め | 0 | 0 |
| うち、誇張 | 10 | 1 |
| うち、回答に無い事実・感情 | 28 | 8 |
| 平均の文字数 | 88字 | 40字 |

**意味検証モデルの比較**（正解付きの20文。NG にすべき11文・そのままでよい9文）
| モデル | 正解率 | NG を見つけた数 | 誤って NG にした数 | 待ち時間 p50 / p95 |
|---|---|---|---|---|
| gpt-4o-mini（今の `OPENAI_MODEL`） | 80% | 10/11 | 3/9 | 0.64秒 / 0.82秒 |
| **gpt-4.1-mini** | **100%** | **11/11** | **0/9** | **0.57秒 / 0.63秒** |
| gpt-4.1 | 100% | 11/11 | 0/9 | 0.59秒 / 0.88秒 |

- 意味検証と修正は **gpt-4.1-mini** をすすめる（`OPENAI_MODEL_REVIEW_VERIFICATION` と `OPENAI_MODEL_REVIEW_REPAIR` に設定する）。gpt-4o-mini は正しい文を誤って NG にすることが多く、そのぶん文が削られて下書きが短くなった。また、修正のときに「[出典: M2]」のような書式を本文に写したり、文法の崩れた文を作ったりした（どちらも後処理と Linter で防ぐようにした）。
- 作文は、決めたとおり今の `OPENAI_MODEL`（gpt-4o-mini）のまま。v2 の下書きは v1 より短い（平均40字）。回答に無い内容を足さないためで、回答が少ないと1〜2文になる。
- 監査で残った指摘の多くは、語彙のリストに無い言い回しで小さな感想を足したもの（例:「気分がリフレッシュしました」）。同期検証をしなかった下書きは、本番では影の検証で計測される（§4）。
- 評価のあとに、決定的な後処理（文末の「〜が、」を閉じる）と語彙の追加をした。単体テストで確かめているが、評価は再実行していない。
- v2 に切り替える前に、オーナーによる目視確認（30件）を行う。

## 7. 環境変数（すべて任意）
| 名前 | 既定 | 内容 |
|---|---|---|
| `REVIEW_PIPELINE` | 未設定（v1） | `v2` のときだけ新しい生成を使う |
| `REVIEW_RATE_LIMIT_IP_SALON_PER_10MIN` | 20 | IP＋店舗あたり、10分間の上限 |
| `REVIEW_RATE_LIMIT_SALON_PER_DAY` | 300 | 店舗あたり、1日（UTC の 0 時 = 日本時間 9 時に切り替わる）の上限 |
| `REVIEW_SHADOW_VERIFY_RATE` | 0.2 | 同期検証をしなかった v2 の下書きに、計測用の検証をかける割合 |
| `RATE_LIMIT_HASH_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | IP をハッシュにするときの鍵 |
| `OPENAI_MODEL_REVIEW_VERIFICATION` | `OPENAI_MODEL` | 意味検証のモデル。**gpt-4.1-mini をすすめる**（§6） |
| `OPENAI_MODEL_REVIEW_REPAIR` | `OPENAI_MODEL` | 部分修正のモデル。**gpt-4.1-mini をすすめる**（§6） |
