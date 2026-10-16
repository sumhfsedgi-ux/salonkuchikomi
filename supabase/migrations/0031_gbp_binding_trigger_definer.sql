-- 0031: 口コミの結び付けの変更のトリガー(0028 の gbp_binding_changed)を、定義者の権限で動かす。
--
-- 不具合:店舗のオーナーのアカウントを削除すると(Supabase の認証の管理の削除。supabase_auth_admin が auth.users を消し、
-- cascade で profiles → salons → salon_google_bindings が消える)、このトリガーが削除を行った役割で動き、
-- public.salons を読めずに(permission denied)削除全体が失敗していた。口コミを連携した店舗のアカウントだけが消せない。
-- 直し方:0024 の利用可否のトリガーと同じく security definer にする(中身は 0028 と同じ)。トリガーが行うのは、
-- その店舗の有効なロケーションを無効にして一時保存を消すことだけで、呼び出した側から値を受け取らない。
-- 0028 は共有テスト用DBに適用済みのため書き換えず、この migration で直す。何度実行しても同じ結果になる。

create or replace function public.gbp_binding_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 店舗ごと削除されている途中(外部キーの cascade)なら何もしない(ロケーションも cascade で消える)。
  if not exists (select 1 from public.salons s where s.id = old.salon_id) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.feature = 'gbp' then
      perform public.gbp_deactivate_salon_locations(old.salon_id);
    end if;
    return null;
  end if;
  if new.feature = 'gbp' and (
       new.google_account_id is distinct from old.google_account_id
       or new.salon_id is distinct from old.salon_id
       or (new.gbp_selection_state is distinct from 'selected' and old.gbp_selection_state = 'selected')) then
    perform public.gbp_deactivate_salon_locations(old.salon_id);
  end if;
  return null;
end;
$$;

revoke all on function public.gbp_binding_changed() from public, anon, authenticated;
grant execute on function public.gbp_binding_changed() to service_role;
