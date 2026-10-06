-- 新版を追加するだけ。既存テンプレート・店舗の質問・回答には書き込まない。
-- 本番・共有DBでは未適用。カテゴリ名で再実行しても重複しない。
do $migration$
declare
  item jsonb; q jsonb; opt jsonb; template_id_value uuid; question_id_value uuid;
  q_order integer; o_order integer;
begin
  for item in select value from jsonb_array_elements($templates$[
  {
    "category": "herb_peeling_writing_v2",
    "name": "ハーブピーリング（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "肌がしっとりした",
          "肌がなめらかに感じた",
          "特に変化は感じなかった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "esthetic_facial_writing_v2",
    "name": "エステ・フェイシャル（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "肌がしっとりした",
          "肌が柔らかく感じた",
          "特に変化は感じなかった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "massage_bodywork_writing_v2",
    "name": "整体・マッサージ（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "気持ちよかった",
          "体が軽く感じた",
          "特に変化は感じなかった",
          "力加減が合わなかった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "hair_salon_writing_v2",
    "name": "美容室（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "理想通りの仕上がりだった",
          "髪が扱いやすくなった",
          "ふつうだった",
          "希望と違う点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "nail_salon_writing_v2",
    "name": "ネイルサロン（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "デザインが気に入った",
          "理想通りの仕上がりだった",
          "ふつうだった",
          "希望と違う点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
        "type": "text",
        "required": false,
        "max": null,
        "options": []
      }
    ]
  },
  {
    "category": "eyelash_writing_v2",
    "name": "アイラッシュ・眉毛（口コミ作成・新版）",
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
        "text": "仕上がりや施術後について、どう感じましたか？",
        "options": [
          "理想通りの仕上がりだった",
          "ナチュラルな仕上がりが気に入った",
          "ふつうだった",
          "改善してほしい点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "スタッフの対応はいかがでしたか？",
        "options": [
          "カウンセリングが丁寧だった",
          "説明が分かりやすかった",
          "相談しやすかった",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": true,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "店内について、どう感じましたか？",
        "options": [
          "清潔感があって安心できた",
          "落ち着いて過ごせた",
          "リラックスできた",
          "ふつうだった",
          "気になる点があった",
          "その他"
        ],
        "required": false,
        "type": "multiple",
        "max": 3
      },
      {
        "text": "今後のご利用について教えてください",
        "options": [
          "ぜひまた来たい",
          "機会があればまた利用したい",
          "別のメニューも試したい",
          "人に紹介したい",
          "まだ分からない",
          "利用する予定はない"
        ],
        "required": false,
        "type": "single",
        "max": null
      },
      {
        "text": "良かった点や気になった点など、ご自由にお書きください",
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
    values (item->>'name', item->>'category', '具体的な感想と今後の意向から口コミを作る新版です。既存の質問は自動で切り替わりません。')
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
end;
$migration$;
