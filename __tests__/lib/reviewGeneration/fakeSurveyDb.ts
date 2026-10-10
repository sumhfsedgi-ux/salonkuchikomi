// アンケートの読み取りのテスト用の、偽の Supabase(外部通信なし)。
// 変更前の読み取り(4つの表を順番に)と、変更後の読み取り(店舗 + 質問・選択肢を埋め込んだアンケート)の
// 両方に、同じ表の中身から答える。並べ方は、order を指定されたときだけ sort_order の順にする
// (指定し忘れたら、入れた順のまま返るので、テストで気づける)。

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type TableName = "salon_public" | "surveys" | "questions" | "question_options";

export interface FakeTables {
  salon_public: Row[];
  surveys: Row[];
  questions: Row[];
  question_options: Row[];
}

export interface FakeDbError {
  message: string;
  code: string;
}

const sortBySortOrder = (rows: Row[]) => [...rows].sort((a, b) => (a.sort_order as number) - (b.sort_order as number));

export function fakeSurveyDb(tables: FakeTables, errors: Partial<Record<TableName, FakeDbError>> = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const requests: TableName[] = [];

  const from = (table: TableName) => {
    const state = {
      select: "",
      eq: [] as Array<[string, unknown]>,
      in: [] as Array<[string, unknown[]]>,
      order: [] as Array<{ column: string; table?: string }>,
    };

    const embedQuestions = (surveyId: unknown) => {
      let questions = tables.questions.filter((q) => q.survey_id === surveyId);
      if (state.order.some((o) => o.table === "questions" && o.column === "sort_order")) questions = sortBySortOrder(questions);
      return questions.map((q) => {
        let options = tables.question_options.filter((o) => o.question_id === q.id);
        if (state.order.some((o) => o.table === "questions.question_options" && o.column === "sort_order")) {
          options = sortBySortOrder(options);
        }
        return {
          id: q.id,
          question_text: q.question_text,
          question_type: q.question_type,
          max_selections: q.max_selections,
          question_options: options.map((o) => ({ option_text: o.option_text })),
        };
      });
    };

    const run = async (single: boolean) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      requests.push(table);
      // 通信の待ちの代わり。同時に出した問い合わせが重なるようにする。
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;

      const error = errors[table];
      if (error) return { data: null, error };
      let rows = tables[table].filter(
        (r) => state.eq.every(([c, v]) => r[c] === v) && state.in.every(([c, vs]) => vs.includes(r[c])),
      );
      if (state.order.some((o) => !o.table && o.column === "sort_order")) rows = sortBySortOrder(rows);
      if (table === "surveys" && state.select.includes("questions(")) {
        rows = rows.map((s) => ({ id: s.id, questions: embedQuestions(s.id) }));
      }
      if (!single) return { data: rows, error: null };
      if (rows.length > 1) return { data: null, error: { message: "JSON object requested, multiple rows returned", code: "PGRST116" } };
      return { data: rows[0] ?? null, error: null };
    };

    const builder = {
      select(columns: string) {
        state.select = columns;
        return builder;
      },
      eq(column: string, value: unknown) {
        state.eq.push([column, value]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        state.in.push([column, values]);
        return builder;
      },
      order(column: string, options?: { referencedTable?: string }) {
        state.order.push({ column, table: options?.referencedTable });
        return builder;
      },
      maybeSingle() {
        return run(true);
      },
      then<A, B>(resolve: (value: Awaited<ReturnType<typeof run>>) => A, reject?: (reason: unknown) => B) {
        return run(false).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    client: { from } as unknown as SupabaseClient,
    stats: () => ({ maxInFlight, requests: [...requests] }),
  };
}
