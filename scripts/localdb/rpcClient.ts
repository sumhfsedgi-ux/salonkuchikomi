// ローカルの PostgreSQL の関数を、Supabase のクライアントの rpc() と同じ形({ data, error })で呼ぶ(テスト用)。
// 結果は JSON にしてから返す(時刻は ISO の文字列、numeric は数値。PostgREST と同じ形)。
// 引数は、関数の宣言の型に明示的に変換して渡す(名前付きの引数)。lib/gbp/supabaseStore.ts の RpcClient を満たす。
import type { Sql } from "postgres";
import type { RpcClient } from "@/lib/gbp/supabaseStore";

interface FunctionInfo {
  returnsSet: boolean;
  types: Map<string, string>;
}

export function createLocalRpcClient(sql: Sql): RpcClient {
  const cache = new Map<string, FunctionInfo>();

  async function info(fn: string): Promise<FunctionInfo> {
    const hit = cache.get(fn);
    if (hit) return hit;
    const [row] = await sql<{ retset: boolean; args: string }[]>`
      select p.proretset as retset, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${fn} limit 1`;
    if (!row) throw Object.assign(new Error(`function ${fn} not found`), { code: "PGRST202" });
    const types = new Map<string, string>();
    for (const part of row.args.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [name, ...type] = part.split(/\s+/);
      types.set(name, type.join(" "));
    }
    const value = { returnsSet: row.retset, types };
    cache.set(fn, value);
    return value;
  }

  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      try {
        const { returnsSet, types } = await info(fn);
        const keys = Object.keys(args);
        const params: unknown[] = [];
        const named = keys.map((key, i) => {
          const value = args[key];
          const type = types.get(key) ?? "text";
          // 値はそのままの型で渡す(ドライバーが宣言の型に合わせて送る。文字列にすると、真偽値の "true" が false になる・
          // jsonb が JSON の文字列として二重に包まれる)。
          params.push(value === undefined ? null : value);
          return `${key} => $${i + 1}::${type}`;
        });
        const call = `public.${fn}(${named.join(", ")})`;
        const query = returnsSet ? `select coalesce(json_agg(t), '[]'::json) as j from ${call} t` : `select to_json(${call}) as j`;
        const [row] = await sql.unsafe<{ j: unknown }[]>(query, params as never[]);
        return { data: row.j, error: null };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return { data: null, error: { code: e.code, message: e.message } };
      }
    },
  };
}
