-- 良かった点を選ぶ6業種のテンプレートへ更新し、旧標準12カテゴリを削除する。
-- 0018適用済み・未適用のどちらでも実行可能。0013〜0017への依存はない。
-- 既存店舗のアンケート・独自テンプレート・予約通知には書き込まない。
-- 全体を1トランザクションで実行する。途中で失敗した場合は削除も確定しない。
begin;

create or replace function public.create_survey_from_template(
  p_salon_id uuid,
  p_template_id uuid,
  p_survey_name text default '口コミアンケート'
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_survey_id uuid;
  v_question_id uuid;
  tq record;
  opt record;
begin

  -- 削除前に開いた画面から旧IDが送られても、既存アンケートを変更しない。
  if p_template_id is not null and not exists (
    select 1 from public.survey_templates t
    join public.template_questions q on q.template_id = t.id
    where t.id = p_template_id
  ) then
    raise exception '選択したテンプレートは利用できません。画面を再読み込みしてください。'
      using errcode = 'P0002';
  end if;
  insert into surveys (salon_id, name, is_active)
  values (p_salon_id, p_survey_name, true)
  returning id into v_survey_id;

  if p_template_id is not null then
    for tq in
      select * from template_questions
      where template_id = p_template_id
      order by sort_order
    loop
      insert into questions (survey_id, question_text, question_type, required, max_selections, sort_order)
      values (v_survey_id, tq.question_text, tq.question_type, tq.required, tq.max_selections, tq.sort_order)
      returning id into v_question_id;

      for opt in
        select * from template_question_options
        where template_question_id = tq.id
        order by sort_order
      loop
        insert into question_options (question_id, option_text, sort_order)
        values (v_question_id, opt.option_text, opt.sort_order);
      end loop;
    end loop;
  end if;

  -- 明示的な「0から作成」以外で空のアンケートを確定しない。
  if p_template_id is not null and not exists (
    select 1 from public.questions where survey_id = v_survey_id
  ) then
    raise exception 'テンプレートの質問を取得できません。画面を再読み込みしてください。'
      using errcode = 'P0002';
  end if;

  return v_survey_id;
end;
$$;

create or replace function public.restart_survey_from_template(
  p_salon_id uuid,
  p_template_id uuid,
  p_survey_name text default '口コミアンケート'
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_survey_id uuid;
  v_question_id uuid;
  tq record;
  opt record;
begin

  -- 削除前に開いた画面から旧IDが送られても、既存アンケートを変更しない。
  if p_template_id is not null and not exists (
    select 1 from public.survey_templates t
    join public.template_questions q on q.template_id = t.id
    where t.id = p_template_id
  ) then
    raise exception '選択したテンプレートは利用できません。画面を再読み込みしてください。'
      using errcode = 'P0002';
  end if;
  update surveys
  set is_active = false, updated_at = now()
  where salon_id = p_salon_id and is_active = true;

  insert into surveys (salon_id, name, is_active)
  values (p_salon_id, p_survey_name, true)
  returning id into v_survey_id;

  if p_template_id is not null then
    for tq in
      select * from template_questions
      where template_id = p_template_id
      order by sort_order
    loop
      insert into questions (survey_id, question_text, question_type, required, max_selections, sort_order)
      values (v_survey_id, tq.question_text, tq.question_type, tq.required, tq.max_selections, tq.sort_order)
      returning id into v_question_id;

      for opt in
        select * from template_question_options
        where template_question_id = tq.id
        order by sort_order
      loop
        insert into question_options (question_id, option_text, sort_order)
        values (v_question_id, opt.option_text, opt.sort_order);
      end loop;
    end loop;
  end if;

  -- 明示的な「0から作成」以外で空のアンケートを確定しない。
  if p_template_id is not null and not exists (
    select 1 from public.questions where survey_id = v_survey_id
  ) then
    raise exception 'テンプレートの質問を取得できません。画面を再読み込みしてください。'
      using errcode = 'P0002';
  end if;

  return v_survey_id;
end;
$$;

do $templates_refresh$
declare
  item jsonb; q jsonb; opt jsonb; template_id_value uuid; question_id_value uuid;
  q_order integer; o_order integer;
begin
  for item in select value from jsonb_array_elements($templates$[
  {
    "category": "herb_peeling_writing_v3",
    "name": "ハーブピーリング",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "ハーブピーリング",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "肌がしっとりした",
          "肌がなめらかに感じた",
          "肌の手触りが気に入った",
          "肌が明るく見えた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "esthetic_facial_writing_v3",
    "name": "エステ・フェイシャル",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "フェイシャル",
          "保湿ケア",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "肌がしっとりした",
          "肌が柔らかく感じた",
          "肌の手触りが気に入った",
          "肌が明るく見えた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "massage_bodywork_writing_v3",
    "name": "整体・マッサージ",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "整体",
          "ボディマッサージ",
          "ヘッドケア",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "気持ちよかった",
          "体が軽く感じた",
          "力加減がちょうどよかった",
          "すっきりした気分になった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "hair_salon_writing_v3",
    "name": "美容室",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "カット",
          "カラー",
          "パーマ",
          "トリートメント",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "理想通りの仕上がりだった",
          "髪が扱いやすくなった",
          "色味が気に入った",
          "自分に合うスタイルになった",
          "セットがしやすくなった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "nail_salon_writing_v3",
    "name": "ネイルサロン",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "ハンドネイル",
          "フットネイル",
          "ネイルケア",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "デザインが気に入った",
          "理想通りの仕上がりだった",
          "色味が気に入った",
          "細かいところまできれいに仕上がった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "eyelash_writing_v3",
    "name": "アイラッシュ・眉毛",
    "questions": [
      {
        "text": "今回のご来店は何回目ですか？",
        "options": [
          "初めて",
          "2回以上"
        ],
        "required": true,
        "type": "single",
        "max": null
      },
      {
        "text": "今回利用したメニューを教えてください",
        "options": [
          "まつげパーマ",
          "まつげエクステ",
          "眉毛パーマ",
          "眉スタイリング",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "仕上がりや施術後について、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "理想通りの仕上がりだった",
          "ナチュラルな仕上がりが気に入った",
          "目元の印象が気に入った",
          "メイクがしやすくなった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "カウンセリングが丁寧だった",
          "希望をしっかり聞いてくれた",
          "説明が分かりやすかった",
          "相談しやすかった",
          "施術中も気遣ってくれた"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内の雰囲気で、良かった点を教えてください（当てはまるものだけ）",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "インテリアや雰囲気がおしゃれだった"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について、当てはまるものを教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "特に良かった点や印象に残ったことを、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  }
]$templates$::jsonb)
  loop
    insert into public.survey_templates (name, category, description)
    values (item->>'name', item->>'category', '良かった点を選んで口コミを作るテンプレートです。感想・今後の意向は任意で、当てはまる項目だけ選べます。')
    on conflict (category) do nothing
    returning id into template_id_value;
    if template_id_value is null then continue; end if;
    q_order := 0;
    for q in select value from jsonb_array_elements(item->'questions') loop
      q_order := q_order + 1;
      insert into public.template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
      values (template_id_value, q->>'text', q->>'type', (q->>'required')::boolean, (q->>'max')::integer, q_order)
      returning id into question_id_value;
      o_order := 0;
      for opt in select value from jsonb_array_elements(q->'options') loop
        o_order := o_order + 1;
        insert into public.template_question_options (template_question_id, option_text, sort_order)
        values (question_id_value, opt #>> '{}', o_order);
      end loop;
    end loop;
  end loop;

  -- 新版6件が各7問あることを確認してから、旧標準テンプレートだけを削除する。
  if (select count(*) from public.survey_templates where category in ('herb_peeling_writing_v3', 'esthetic_facial_writing_v3', 'massage_bodywork_writing_v3', 'hair_salon_writing_v3', 'nail_salon_writing_v3', 'eyelash_writing_v3')) <> 6
    or exists (
      select t.id from public.survey_templates t
      left join public.template_questions q on q.template_id = t.id
      where t.category in ('herb_peeling_writing_v3', 'esthetic_facial_writing_v3', 'massage_bodywork_writing_v3', 'hair_salon_writing_v3', 'nail_salon_writing_v3', 'eyelash_writing_v3')
      group by t.id having count(q.id) <> 7
    ) then
    raise exception '新版テンプレートの質問を確認できないため、旧版の削除を中止しました。';
  end if;

  -- コピー済みのsurveys/questions/question_optionsはテンプレートを参照していない。
  -- categoryを列挙し、独自テンプレートは削除対象にしない。
  delete from public.survey_templates where category in (
    'herb_peeling',
    'herb_peeling_writing_v2',
    'esthetic_facial',
    'esthetic_facial_writing_v2',
    'massage_bodywork',
    'massage_bodywork_writing_v2',
    'hair_salon',
    'hair_salon_writing_v2',
    'nail_salon',
    'nail_salon_writing_v2',
    'eyelash',
    'eyelash_writing_v2'
  );
end;
$templates_refresh$;

commit;
