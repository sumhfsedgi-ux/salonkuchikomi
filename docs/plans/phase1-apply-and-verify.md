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
| アプリ | お客様ページの文言：「口コミの下書きができました」「内容を確認して、必要に応じて編集してください。」、CTA「この内容をコピーしてGoogleへ進む」、補足「自動で投稿されることはありません」（2026-10-04 に短くした） | 文言が変わる |
| DB（要適用） | `supabase/migrations/0012_review_generation_events.sql`：`ai_generation_events`、`rate_limit_buckets`、`rate_limit_hit()` | 新しいテーブルと関数だけ。既存のテーブルは変更しない |

変更していないもの：seed.sql（選択肢は追加しない）、APP_MODE、`lib/notifications/**`、0009 のテーブル、blog の生成処理、hmail。

## 1. リリースの順番
1. Phase 1 を master に取り込み、本番にデプロイする（`REVIEW_PIPELINE` は未設定のまま = v1）。
2. 0012 を本番 Supabase に適用し、§3 の確認をする。
3. オフライン評価（§6）・自動テスト・目視確認・待ち時間・lint の違反率・意味検証の結果を見て、問題なければ Vercel の環境変数に `REVIEW_PIPELINE=v2`、`OPENAI_MODEL_REVIEW_GENERATION=gpt-4.1-mini`、`OPENAI_MODEL_REVIEW_VERIFICATION=gpt-4.1-mini`、`OPENAI_MODEL_REVIEW_REPAIR=gpt-4.1-mini` を設定して再デプロイする。
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

## 6. オフライン評価の結果（2026-10-04、生成方針の変更後）
生成方針（v3.1）：**事実は作らない。ただし感情・温度感・主観的な反応は、回答と矛盾しない範囲で補ってよい**。
`npm run eval:review`（架空の回答36件。うち、自由記述・「その他」に否定的な内容を含むもの13件）。下書きは gpt-4.1 が次の2つの観点で判定した。
- 監査：素材と見比べて、事実・効果の捏造、極端な感情、否定の反転・弱めがないか。
- 読み手としての採点：気持ち・温度感（1〜5）、自然さ（1〜5）、アンケートの要約に見えるか。

v2 は2回評価した（2回目は、帳消しの締めなどの検査を足したあと）。LLM の出力には揺れがあるので、両方の値を載せる。

| 指標 | v1（今の本番） | v2（1回目 / 2回目） |
|---|---|---|
| 失敗 | 0/36 | 0/36 / 0/36 |
| 待ち時間 p50 / p95 | 1.1秒 / 1.9秒 | 2.0秒 / 4.0秒、1.9秒 / 4.0秒 |
| 平均の文字数 | 90字 | 76字 / 70字 |
| 気持ち・温度感（平均） | 3.42 | 3.50 / 3.44 |
| 自然さ（平均） | 3.69 | 3.85 / 3.72 |
| アンケートの要約に見える下書き | 15/36 | 8/36 / 12/36 |
| 監査で問題があった下書き | 16/36 | 4/36 / 9/36 |
| 監査で問題があった文 | 21/82 | 6/52 / 10/83 |
| うち、効果の捏造 / 事実の捏造 / 極端な感情 | 12 / 9 / 1 | 2 / 3 / 1、8 / 3 / 0 |
| 否定的な内容の反映（語の一致による目安） | 11/13 | 12/13 / 11/13 |

- 否定的な内容の反映は、目印の語がそのまま残っているかで数えている。v2 で数えられなかったものは、言い換え（例：「寒かった」→「寒く感じた」）で、内容は残っている。
- v2 は、事実・効果の捏造が v1 の半分以下で、要約のような下書きも少ない。気持ち・温度感と自然さは v1 と同じくらいか、少し上。
- 残る指摘の多くは、気持ちに見える形で結果を足したもの（例：「自信が持てるようになりました」「肌がこんな風に変わることに驚き」）。評価のあとに、これらの語を検査に足した（単体テストで確認。評価は再実行していない）。

**意味検証モデルの比較**（v3.1 の基準に合わせた正解付きの25文。NG にすべき14文、そのままでよい11文。気持ちを補った文は「そのままでよい」に含む）
| モデル | 正解率 | NG を見つけた数 | 誤って NG にした数 | 待ち時間 p50 / p95 |
|---|---|---|---|---|
| gpt-4o-mini（今の `OPENAI_MODEL`） | 88% | 13/14 | 2/11 | 0.75秒 / 0.89秒 |
| **gpt-4.1-mini** | **100%** | **14/14** | **0/11** | **0.53秒 / 0.62秒** |

- 意味検証と修正は **gpt-4.1-mini** をすすめる（`OPENAI_MODEL_REVIEW_VERIFICATION` と `OPENAI_MODEL_REVIEW_REPAIR`）。

**作文モデルの比較**（意味検証・修正はどちらも gpt-4.1-mini。構成プランで「否定的な素材だけの口コミにしない」を足したあと、同じ日に続けて評価）
| 指標 | v1（今の本番） | 作文 gpt-4o-mini | **作文 gpt-4.1-mini** |
|---|---|---|---|
| 失敗 | 0/36 | 0/36 | 0/36 |
| 待ち時間 p50 / p95 | 1.1秒 / 1.9秒 | 1.7秒 / 3.1秒 | 1.4秒 / 3.3秒 |
| 平均の文字数 | 90字 | 66字 | 64字 |
| 気持ち・温度感（平均） | 3.42 | 3.14 | 3.36 |
| 自然さ（平均） | 3.69 | 3.39 | 3.67 |
| アンケートの要約に見える下書き | 15/36 | 16/36 | 9/36 |
| 監査で問題があった下書き | 16/36 | 9/36 | 4/36 |
| 監査で問題があった文（効果 / 事実の捏造） | 21/82 | 10/79（5 / 5） | 5/76（2 / 3） |
| 否定的な内容の反映 | 11/13 | 13/13 | 13/13 |

- gpt-4o-mini は回によって揺れが大きい（上の表と合わせた3回で、気持ち・温度感 3.14〜3.50、要約に見える下書き 8〜16件、監査で問題があった下書き 4〜9件）。gpt-4.1-mini は2回とも近い値（構成プランの修正前の回：3.28・10件・3件）。
- gpt-4.1-mini は、捏造が v1 の約4分の1で、気持ち・温度感と自然さは v1 と同じくらい、要約のような下書きは v1 より少ない。→ **作文も gpt-4.1-mini をすすめる**（`OPENAI_MODEL_REVIEW_GENERATION`）。単価は gpt-4o-mini より高い（1回の生成で平均約3,200トークン）。
- gpt-4.1-mini の回で監査の呼び出しが一部失敗したので、保存した下書きを作り直さずに監査し直した（`EVAL_REAUDIT`）。上の値は監査し直したもの。
- 評価のあとに直したもの（単体テストで確認。評価は再実行していない）：
  - 「2〜3回目」と答えた人の下書きに「初めてでも」と書かれた例があった。回答に無い「初めて」を検査に足した（2回目以降と答えていれば表示しない、来店回数が分からなければ意味検証にかける）。
  - 否定的な内容の反映の数え方で、「分かりにくい」と「わかりにくい」のような表記ゆれを同じとみなすようにした。
**「綺麗な作文」をやめた版（review-v2.4）**（2026-10-04。作文・意味検証・修正はすべて gpt-4.1-mini）

オーナーの確認で「AIが口コミとして綺麗にまとめた文章」に見えるという指摘があり、次を変えた。
- プロンプト：整いすぎた言い回し（嬉しく思いました／〜することができました／〜と思える体験でした／心地よい体験でした／満足のいく時間でした／印象に残りました／安心感がありました）と、最後の総括文をやめる。「嬉しかったです」「またお願いしたいです！」のような直接的で少しラフな言い方にする。例文も同じ方向に直した。
- 構成プラン：締めの型から「全体の感想」をなくした（素直な一言／締めなし／短い意向の一言）。感嘆符の使い方を生成ごとに選ぶ（使わない／最後の文だけ1つ／文中に1〜2個）。否定的な内容がある下書きでは「最後の文だけ」を選ばない。
- Linter：`abstract_ai_summary`（抽象的な名詞でまとめる・「〜と思える〜でした」・最後の文の「全体的に〜」）と `exclamation_overuse`（3つ以上・「！！」。感嘆符があるだけでは指摘しない）を追加した。整いすぎた言い回しは `template_phrase:polished` として検出する。気持ちを言い切った短い文（「嬉しい！」）は断片とみなさない。
- パイプライン：意味を変えずに直せる言い回し（「嬉しく思いました」→「嬉しかったです」、「〜することができました」→「〜できました」など）はコードで直す（お客様が自分で書いた言い回しは残す）。最後の文が抽象的な総括で、その素材が他の文にも使われていれば削る。残った指摘は1回だけ書き直す。感嘆符が3つ以上なら、前の文から句点に戻す。
- 評価の採点：自然さに「文章として完成されすぎていないこと」を含めた（口語的・短い文・たまの「！」・単純な感想で終わる・締めが無い、は減点しない）。「AIが綺麗にまとめた作文に見えるか」も判定する。

前回の下書き（review-v2.3）も新しい基準で採点し直して比べた（v1 は採点し直していない）。

| 指標 | review-v2.3（前回の下書き） | **review-v2.4** |
|---|---|---|
| 綺麗にまとめた作文に見える下書き | 32/36 | **4/36** |
| 自然さ（平均。新しい基準） | 2.58 | **4.11** |
| 気持ち・温度感（平均） | 2.56 | **3.33** |
| アンケートの要約に見える下書き | 8/36 | 2/36 |
| 抽象的なまとめ・整いすぎた言い回し（Linter） | 17/36 | 0/36 |
| 感嘆符の数（なし / 1つ / 2つ / 3つ以上） | 35 / 1 / 0 / 0 | 16 / 20 / 0 / 0 |
| 監査で問題があった下書き | 5/34（2件は監査が失敗） | 4/36 |
| 否定的な内容の反映 | 13/13 | 13/13 |
| 平均の文字数 | 64字 | 52字 |
| 待ち時間 p50 / p95 | 1.4秒 / 3.3秒 | 1.4秒 / 2.7秒 |

- 書き直し（追加の LLM 呼び出し）が起きたのは36件中1件だけ。ほとんどはプロンプトとコードの修正で収まっている。
- 評価のあとに直したもの（単体テストで確認。評価は再実行していない）：
  - 「初めて」と否定的な自由記述だけで書かれ、「自然な仕上がり」と答えたことが消えた例があった。構成プランの「否定的な素材だけの口コミにしない」で、来店回数を肯定的な内容に数えないようにした。
  - 「リラックスできる時間が過ごせました」を抽象的なまとめとして検出するようにした。「楽になった」を効果の断定の語に足した（意味検証にかける）。
- API 呼び出し：生成と採点で138回、前回の下書きの採点し直しで82回（失敗のやり直しを含む）。

- v2 に切り替える前に、オーナーによる目視確認（30件）を行う。

**目視確認（2026-10-04）**：最終版のコード（review-v2.4）で架空の回答36件から作り直した下書きを、オーナーが確認し、**36件すべて OK**。同じ回の自動評価：失敗 0/36、綺麗にまとめた作文に見える 0/36、自然さ 4.31・気持ち・温度感 3.44、監査で問題があった下書き 2/36、否定的な内容の反映 13/13（自動の数え方では 12/13。漏れとされた1件は「寒かった」を「寒くて」と書いたもので、反映されている）、待ち時間 p95 3.0秒。API 呼び出し 142回。

## 7. 環境変数（すべて任意）
| 名前 | 既定 | 内容 |
|---|---|---|
| `REVIEW_PIPELINE` | 未設定（v1） | `v2` のときだけ新しい生成を使う |
| `REVIEW_RATE_LIMIT_IP_SALON_PER_10MIN` | 20 | IP＋店舗あたり、10分間の上限 |
| `REVIEW_RATE_LIMIT_SALON_PER_DAY` | 300 | 店舗あたり、1日（UTC の 0 時 = 日本時間 9 時に切り替わる）の上限 |
| `REVIEW_SHADOW_VERIFY_RATE` | 0.2 | 同期検証をしなかった v2 の下書きに、計測用の検証をかける割合 |
| `RATE_LIMIT_HASH_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | IP をハッシュにするときの鍵 |
| `OPENAI_MODEL_REVIEW_GENERATION` | `OPENAI_MODEL` | 作文のモデル。**gpt-4.1-mini をすすめる**（§6） |
| `OPENAI_MODEL_REVIEW_VERIFICATION` | `OPENAI_MODEL` | 意味検証のモデル。**gpt-4.1-mini をすすめる**（§6） |
| `OPENAI_MODEL_REVIEW_REPAIR` | `OPENAI_MODEL` | 部分修正のモデル。**gpt-4.1-mini をすすめる**（§6） |

## 8. 本番の状態（2026-10-04）
1. master に取り込み（`e1a032c`）、本番にデプロイした（v1 のまま）。
2. 運営者が 0012 を本番 Supabase に適用した。anon からはテーブル2つ・関数とも 42501 になることを確認した（書き込みは起きない方法で確認）。
3. オーナーの目視確認（§6）のあと、Production に `REVIEW_PIPELINE=v2`、`OPENAI_MODEL_REVIEW_GENERATION` / `OPENAI_MODEL_REVIEW_VERIFICATION` / `OPENAI_MODEL_REVIEW_REPAIR`（すべて `gpt-4.1-mini`）を設定し、再デプロイした。**v2 に切り替え済み**。
4. 以降は §4 のクエリで様子を見る。戻すときは §5。

## 9. 未対応・別タスク
- **下書きの細かな改善**（目視確認では OK。急がない）
  - 回答に無いやり取りを足すことがある（例：「予約した時から安心できて、やりとりもスムーズでした」）。「やりとり」「予約した時」なども、回答に無ければ意味検証にかける語に加えるか検討する。
  - 同じ内容を2回書くことがある（例：「体が軽くなった気がします。体が軽くなった気がして嬉しかったです。」）。同じ素材を同じ言い回しで繰り返す文を検出して削るか検討する。
  - 来店回数を最後に取って付けることがある（例：「…よかったです！2〜3回目でした。」）。
  - 「4回以上」と答えた人の「4回以上通っています」が、語のうえでは「通っています」の根拠が無いため意味検証にかかる（結果は通る）。
- **評価の数え方**：否定的な内容の反映を語の一致で数えているため、活用の違い（「寒かった」と「寒くて」）を漏れと数える。
- **npm audit**：brace-expansion（googleapis → gaxios → rimraf → glob 経由など）の high が1件。master にもとからあるもので、依存の更新は別タスクで行う。
