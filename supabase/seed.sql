-- Seed data for the shared template library (survey_templates /
-- template_questions / template_question_options). Idempotent: re-running
-- (e.g. via `supabase db reset`) truncates and re-inserts everything.
--
-- No medical-effect-implying options anywhere here — every "感想" option is
-- phrased as the customer's own subjective impression ("〜ように感じた" /
-- "〜気がした"), matching the constraint enforced in the AI system prompt.

truncate table survey_templates restart identity cascade;

do $$
declare
  v_template_id uuid;
  v_q1 uuid;
  v_q2 uuid;
  v_q3 uuid;
  v_q4 uuid;
  v_q5 uuid;
begin

  -- ===========================================================================
  -- 1. ハーブピーリング (herb_peeling)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('ハーブピーリング', 'herb_peeling', '肌の悩みや施術後の感想を聞く、ハーブピーリングサロン向けの標準テンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなお悩みでご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, 'ニキビ', 1), (v_q1, 'ニキビ跡', 2), (v_q1, '毛穴の開き', 3), (v_q1, '毛穴の黒ずみ', 4),
    (v_q1, '肌のざらつき', 5), (v_q1, 'くすみ', 6), (v_q1, '乾燥', 7), (v_q1, '赤み', 8),
    (v_q1, '肌荒れ', 9), (v_q1, 'シミ・色ムラ', 10), (v_q1, 'ハリ不足', 11), (v_q1, '肌質を改善したい', 12), (v_q1, 'その他', 13);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術後のお肌について、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, '肌がつるっとした', 1), (v_q2, '肌がなめらかになったように感じた', 2), (v_q2, '肌が柔らかく感じた', 3),
    (v_q2, '肌が明るく見えた', 4), (v_q2, '毛穴が目立ちにくく感じた', 5), (v_q2, '肌のざらつきが気になりにくくなった', 6),
    (v_q2, '肌がしっとりした', 7), (v_q2, '肌がスッキリした', 8), (v_q2, '今後の変化も楽しみ', 9), (v_q2, 'その他', 10);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, '施術が丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, '自分の肌に合った提案をしてくれた', 3),
    (v_q3, '不安なく施術を受けられた', 4), (v_q3, 'リラックスできた', 5), (v_q3, '肌について相談しやすかった', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・サロンについて感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, 'リラックスできる空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

  -- ===========================================================================
  -- 2. エステ・フェイシャル (esthetic_facial)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('エステ・フェイシャル', 'esthetic_facial', 'フェイシャルエステの施術後アンケート向けテンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなお悩みでご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, '毛穴の開き', 1), (v_q1, '毛穴の黒ずみ', 2), (v_q1, 'くすみ', 3), (v_q1, '乾燥', 4),
    (v_q1, 'たるみが気になる', 5), (v_q1, '肌のハリ不足', 6), (v_q1, '肌荒れ', 7), (v_q1, 'シミ・そばかす', 8),
    (v_q1, '日々の疲れ', 9), (v_q1, 'むくみが気になる', 10), (v_q1, 'その他', 11);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術後のお肌について、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, '肌がつるっとした', 1), (v_q2, '肌が明るく見えた', 2), (v_q2, '肌が引き締まったように感じた', 3),
    (v_q2, '顔がすっきりした感じがした', 4), (v_q2, '肌が柔らかくなったように感じた', 5),
    (v_q2, 'むくみが軽くなった気がした', 6), (v_q2, 'リラックスできた', 7), (v_q2, '今後の変化も楽しみ', 8), (v_q2, 'その他', 9);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, '施術が丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, '自分の肌に合った提案をしてくれた', 3),
    (v_q3, '力加減がちょうどよかった', 4), (v_q3, 'リラックスできた', 5), (v_q3, '肌について相談しやすかった', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・サロンについて感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, 'リラックスできる空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

  -- ===========================================================================
  -- 3. 整体・マッサージ (massage_bodywork)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('整体・マッサージ', 'massage_bodywork', '整体・マッサージ店の施術後アンケート向けテンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなお悩みでご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, '肩こり', 1), (v_q1, '腰痛', 2), (v_q1, '首のこり', 3), (v_q1, 'むくみ', 4),
    (v_q1, '疲労感', 5), (v_q1, '姿勢の歪みが気になる', 6), (v_q1, '冷え', 7), (v_q1, '睡眠の質が気になる', 8),
    (v_q1, '運動不足', 9), (v_q1, 'その他', 10);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術後の体調について、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, '体が軽くなったように感じた', 1), (v_q2, '肩や腰が楽になった気がした', 2), (v_q2, '血行が良くなった感じがした', 3),
    (v_q2, '体が温まった感じがした', 4), (v_q2, 'ぐっすり眠れそうな感じがした', 5), (v_q2, 'むくみが軽くなった気がした', 6),
    (v_q2, 'リラックスできた', 7), (v_q2, 'その他', 8);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, '施術が丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, '力加減がちょうどよかった', 3),
    (v_q3, '自分の体に合った施術をしてくれた', 4), (v_q3, '不安なく施術を受けられた', 5), (v_q3, '体の状態について相談しやすかった', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・サロンについて感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, 'リラックスできる空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

  -- ===========================================================================
  -- 4. 美容室 (hair_salon)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('美容室', 'hair_salon', 'カット・カラーなど美容室の来店後アンケート向けテンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなご希望でご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, 'イメージチェンジがしたい', 1), (v_q1, '髪のダメージが気になる', 2), (v_q1, 'くせ毛が気になる', 3),
    (v_q1, '白髪が気になる', 4), (v_q1, '髪のボリュームが気になる', 5), (v_q1, '似合う髪型を探していた', 6),
    (v_q1, '特別なイベントのため', 7), (v_q1, 'その他', 8);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '仕上がりについて、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, '髪がまとまりやすくなった感じがした', 1), (v_q2, '理想通りの仕上がりだった', 2), (v_q2, '髪がつやっとした感じがした', 3),
    (v_q2, '髪が扱いやすくなった気がした', 4), (v_q2, '自分に似合っていると感じた', 5), (v_q2, '軽やかな印象になった', 6), (v_q2, 'その他', 7);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, 'カウンセリングが丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, '自分の要望をしっかり聞いてくれた', 3),
    (v_q3, '技術力を感じた', 4), (v_q3, '仕上がりのイメージを共有してくれた', 5), (v_q3, '相談しやすかった', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・お店について感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, '居心地の良い空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

  -- ===========================================================================
  -- 5. ネイルサロン (nail_salon)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('ネイルサロン', 'nail_salon', 'ネイルサロンの施術後アンケート向けテンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなご希望でご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, 'デザインを変えたい', 1), (v_q1, '爪の補強がしたい', 2), (v_q1, '自爪のケアがしたい', 3),
    (v_q1, '特別なイベントのため', 4), (v_q1, 'セルフケアの限界を感じた', 5), (v_q1, 'ネイルを長持ちさせたい', 6), (v_q1, 'その他', 7);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '仕上がりについて、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, 'イメージ通りのデザインだった', 1), (v_q2, '仕上がりが綺麗だった', 2), (v_q2, '爪が丈夫になった感じがした', 3),
    (v_q2, '持ちが良さそうな感じがした', 4), (v_q2, '自分に似合っていると感じた', 5), (v_q2, '気分が上がった', 6), (v_q2, 'その他', 7);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, 'カウンセリングが丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, 'デザインの相談がしやすかった', 3),
    (v_q3, '丁寧な施術だった', 4), (v_q3, '要望をしっかり聞いてくれた', 5), (v_q3, '仕上がりのイメージを共有してくれた', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・お店について感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, '居心地の良い空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

  -- ===========================================================================
  -- 6. アイラッシュ・まつげ (eyelash)
  -- ===========================================================================
  insert into survey_templates (name, category, description)
  values ('アイラッシュ・まつげ', 'eyelash', 'まつ毛エクステ・パーマなどアイラッシュサロンの施術後アンケート向けテンプレートです。')
  returning id into v_template_id;

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '今回、どのようなご希望でご来店されましたか？', 'multiple', true, 3, 1)
  returning id into v_q1;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q1, 'まつ毛のボリュームを出したい', 1), (v_q1, '自まつ毛のケアがしたい', 2), (v_q1, 'デザインを変えたい', 3),
    (v_q1, '特別なイベントのため', 4), (v_q1, '普段のメイク時間を短縮したい', 5), (v_q1, '持ちの良さを求めて', 6), (v_q1, 'その他', 7);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '仕上がりについて、どのように感じましたか？', 'multiple', true, 3, 2)
  returning id into v_q2;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q2, '目元の印象が変わった感じがした', 1), (v_q2, '仕上がりが自然だった', 2), (v_q2, 'イメージ通りのデザインだった', 3),
    (v_q2, '軽い付け心地だった', 4), (v_q2, '持ちが良さそうな感じがした', 5), (v_q2, '気分が上がった', 6), (v_q2, 'その他', 7);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, '施術について感じたことを教えてください', 'multiple', true, 3, 3)
  returning id into v_q3;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q3, 'カウンセリングが丁寧だった', 1), (v_q3, '説明が分かりやすかった', 2), (v_q3, 'デザインの相談がしやすかった', 3),
    (v_q3, '丁寧な施術だった', 4), (v_q3, '目に負担を感じなかった', 5), (v_q3, '要望をしっかり聞いてくれた', 6);

  insert into template_questions (template_id, question_text, question_type, required, max_selections, sort_order)
  values (v_template_id, 'スタッフ・お店について感じたことを教えてください', 'multiple', true, 3, 4)
  returning id into v_q4;
  insert into template_question_options (template_question_id, option_text, sort_order) values
    (v_q4, 'スタッフが話しやすい', 1), (v_q4, 'スタッフの対応が丁寧', 2), (v_q4, '親身に相談に乗ってくれた', 3),
    (v_q4, '清潔感がある', 4), (v_q4, '落ち着いた雰囲気', 5), (v_q4, '居心地の良い空間', 6), (v_q4, '初めてでも入りやすかった', 7);

  insert into template_questions (template_id, question_text, question_type, required, sort_order)
  values (v_template_id, 'その他、感じたことがあれば自由にご記入ください', 'text', false, 5);

end $$;
