-- 店舗オーナー自身による salons.plan(契約プラン)の改ざんを防ぐ。
--
-- 背景: 0003 の owner_update / owner_insert ポリシーは salons の全列を許可しており、
-- 0010 で追加した plan 列にも保護が無かった。そのため、ログイン済みのオーナーなら
-- 公開されている anon キーと自分のセッションで
--   PATCH /rest/v1/salons?id=eq.<自店舗> {"plan":"salonpack"}
-- を送るだけで、契約していない有料機能(ブログ・予約通知)の判定を通過できてしまう。
-- cron 側も salons.plan を見て判定しているため同様に影響する。
--
-- 方針(docs/plans/reviews-465-plan.md §5 salons_plan_guard):
--   ・anon / authenticated(=ブラウザからのリクエスト)だけを対象にする。
--     service_role(サーバー側の管理処理)と postgres(migration・SQL Editor)は対象外。
--     plan の変更は従来どおり、管理者が service role か SQL Editor で行う。
--   ・INSERT: plan は必ず 'reviews' で始める(lib/access/plan.ts / createSalonAction と同じ前提)。
--   ・UPDATE: クライアントが書き換えてよい列を許可リストで明示し、それ以外の列
--     (plan・owner_id・slug・created_at・将来追加される列)が変わる更新は拒否する。
--     新しい列をクライアントから更新させたい場合は、この許可リストへの追加が必要
--     (追加し忘れた場合は安全側=拒否になる)。
--
-- 許可リストは、現在アプリがセッションクライアント(RLS経由)で salons に書いている列と一致させている:
--   name / description / business_type   ... app/dashboard/settings/actions.ts
--   google_review_url                    ... app/dashboard/reviews/actions.ts
--   google_review_url / onboarding_completed ... app/dashboard/actions.ts
--   business_type                        ... lib/supabase/queries.ts (applyDefaultBusinessType)
--   updated_at                           ... 上記すべて
--
-- 1オーナー1店舗の DB 制約(unique(owner_id))はここでは扱わない。将来の
-- 1オーナー複数店舗・salon_members への拡張を妨げないため、別の問題として
-- アプリ側で扱う(lib/supabase/primarySalon.ts、createSalonAction 参照)。
--
-- current_user で呼び出し元のロールを判定するため、関数は security invoker で作る
-- (security definer にすると current_user が関数の所有者になり、判定が成り立たない)。

create or replace function public.salons_client_write_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  client_writable_columns constant text[] := array[
    'name',
    'description',
    'business_type',
    'google_review_url',
    'onboarding_completed',
    'updated_at'
  ];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.plan is distinct from 'reviews' then
      raise exception 'salons.plan はクライアントから指定できません'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - client_writable_columns) is distinct from (to_jsonb(old) - client_writable_columns) then
    raise exception 'salons のこの列はクライアントから変更できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists salons_client_write_guard on public.salons;

create trigger salons_client_write_guard
  before insert or update on public.salons
  for each row
  execute function public.salons_client_write_guard();
