# 良かった点を選ぶテンプレートへの更新

2026-10-06。口コミ生成の文章改善とは別に、標準アンケート6業種を更新する。

## 内容

- 「気になる点があった」「特に変化は感じなかった」「ふつうだった」「希望と違う点があった」「改善してほしい点があった」「力加減が合わなかった」「まだ分からない」「利用する予定はない」を選択肢から外す。
- 仕上がり、スタッフ、店内は「良かった点」を聞く。業種に合った具体的な選択肢を4〜5個用意する。
- 来店回数と利用メニューの2問だけ必須。良かった点、今後の意向、自由記述は任意で、当てはまるものだけ回答できる。回答によって投稿導線を分岐させない。
- 全業種とも7問。業種はハーブピーリング／エステ・フェイシャル／整体・マッサージ／美容室／ネイルサロン／アイラッシュ・眉毛。
- 本人が自由記述に入力した感想を扱う生成ルールは変更しない。選んでいない評価や再来店意向は追加しない。

## 更新するもの

`supabase/migrations/0019_positive_review_templates.sql` を全文実行する。

- 0018が適用済みでも未適用でも使える。稼働中アプリの既存スキーマ0001〜0012を前提とし、Google機能側の0013〜0017は必要ない。
- `_writing_v3` の標準6件を追加し、質問が各7問あることを確認してから、初期版6カテゴリと0018の6カテゴリを削除する。独自カテゴリは削除しない。
- テンプレートの子の質問・選択肢は外部キーのCASCADEで削除される。店舗の `surveys/questions/question_options` はコピーされた別データなので維持する。
- 古い画面から削除済みIDを選んでも、店舗の質問が空にならないように `create_survey_from_template` と `restart_survey_from_template` の入力確認を追加する。SECURITY INVOKERと既存の権限は維持する。
- 追加、関数更新、旧版削除は1トランザクション。途中で失敗したら確定しない。
- `supabase/seed.sql` も現行6件に揃えた。以前の全テンプレートTRUNCATEをなくし、再実行しても独自テンプレートは残り、旧版は復活しない。
- 新版が既にある場合は上書きしない。繰り返し実行してもID・質問・選択肢は変わらない。

## 適用手順

1. SalonPackが接続しているSupabaseプロジェクトのSQL Editorを開く。
2. `supabase/migrations/0019_positive_review_templates.sql` の全文を貼り付けてRun。0018の再実行やseedの実行は不要。
3. 次の確認SQLを実行。現行6行が各7問、必須2問であればよい。独自テンプレートがある場合はそのまま残る。

```sql
select t.name, t.category,
       count(q.id) as questions,
       count(q.id) filter (where q.required) as required_questions
from public.survey_templates t
left join public.template_questions q on q.template_id = t.id
where t.category in (
  'herb_peeling_writing_v3', 'esthetic_facial_writing_v3',
  'massage_bodywork_writing_v3', 'hair_salon_writing_v3',
  'nail_salon_writing_v3', 'eyelash_writing_v3'
)
group by t.id, t.name, t.category
order by t.name;

select count(*) as remaining_old_templates
from public.survey_templates
where category in (
  'herb_peeling', 'esthetic_facial', 'massage_bodywork',
  'hair_salon', 'nail_salon', 'eyelash',
  'herb_peeling_writing_v2', 'esthetic_facial_writing_v2',
  'massage_bodywork_writing_v2', 'hair_salon_writing_v2',
  'nail_salon_writing_v2', 'eyelash_writing_v2'
);
```

`remaining_old_templates = 0` を確認する。エラー時には後続を実行せず、もし同じSQLセッションがトランザクション中のままであれば `rollback;` を実行する。

4. SalonPackの「口コミ」画面を再読み込み。「テンプレートから作り直す」の一覧が現行6業種（独自テンプレートがあればそれも）になる。再デプロイは不要。
5. 既存店舗の質問は自動では変わらない。変えたい店舗だけ新テンプレートを選ぶ。既存の独自質問を残したい場合は、質問編集画面で不要な選択肢だけ削除する。

## 確認

ローカルの使い捨てPGliteで確認する。ネットワークDBも外部APIも使用しない。

```text
node scripts/check-positive-templates.cjs --pglite-module=<ローカルにインストール済みの@electric-sql/pgliteの絶対パス>
```

比較用の初期seedはGitのa55ce8bから読む。0018の未適用・適用済みの両方、旧標準だけの削除、コピー済み質問と独自テンプレートの保持、再適用とseed、削除済みIDの拒否、新版のコピー、「0から作成」、途中失敗時のロールバックを確認する。2026-10-06、14/14項目成功。

既存の単体テスト278/278成功。追加した検証スクリプトのlintと差分チェックも成功。アプリの画面・生成エンジンのコードには変更がないため、今回buildは再実行していない。

本番・共有DBへの適用は、この文書の作成時点では実施していない。作業ブランチは `feature/positive-review-templates`。未コミット。
