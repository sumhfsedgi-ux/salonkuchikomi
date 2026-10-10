-- 旧側の監視の権限(hmail-legacy-watch-grant.sql)の、付与の前後に行う確認。すべて読み取りだけ(本番の SQL Editor で1つずつ実行)。
-- 期待する結果は各クエリの上に書いた。テスト用DBで、写しのスキーマに対して動作を確認済み。

-- [A] RLS: service_role が RLS を素通りするか(BYPASSRLS)。
--     期待: service_role_bypassrls = true(このとき、RLS の有効・強制・ポリシーの有無に関係なく service_role は読める。
--     ポリシーは追加しない)。false なら付与しても読めない可能性があるため、止めて相談する。
select (select rolbypassrls from pg_roles where rolname = 'service_role') as service_role_bypassrls,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies p where p.schemaname = 'hmail' and p.tablename = 'mail_connections') as policies
  from pg_class c
 where c.oid = 'hmail.mail_connections'::regclass;

-- [B] 列ごとの読み取りの権限。
--     付与の前の期待: salon_id・email_address・status の3列があり、すべて false。
--     付与の後の期待: その3列だけ true。トークンなどのほかの列は false のまま。
select column_name,
       has_column_privilege('service_role', 'hmail.mail_connections', column_name, 'SELECT') as service_role_can_read
  from information_schema.columns
 where table_schema = 'hmail' and table_name = 'mail_connections'
 order by ordinal_position;

-- [C] スキーマの USAGE を付けると、service_role から使えるようになるもの(表・シーケンス・関数の既存の権限)。
--     付与の前・後とも、期待は 0 行(mail_connections の3列だけの権限は、ここには出ない)。
--     付与の前に行が出たら、付与しない(USAGE を付けると、その表・関数が service_role から使えるようになるため)。止めて相談する。
select case when c.relkind = 'S' then 'sequence' else 'table' end as kind, c.relname as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'hmail'
   and case
         when c.relkind in ('r', 'p', 'v', 'm', 'f')
           then has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         when c.relkind = 'S'
           then has_sequence_privilege('service_role', c.oid, 'USAGE,SELECT,UPDATE')
         else false
       end
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'hmail' and has_function_privilege('service_role', p.oid, 'EXECUTE');

-- [D] スキーマの USAGE。付与の前の期待: false。付与の後の期待: true。
select has_schema_privilege('service_role', 'hmail', 'USAGE') as service_role_hmail_usage;
