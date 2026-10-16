-- 0032: Google口コミ(google_reviews)の利用許可を、口コミ(reviews)の利用許可に連動させる。
--
--   ・口コミが使える店舗は、Google口コミも使える。口コミを許可しない店舗は、Google口コミも使えない。
--     プラン・標準・店舗ごとの許可(個別設定)は、reviews の行を読む。google_reviews の行(プランの標準・個別設定)は判定に使わない
--     (運営画面にも出さない。すでにある個別設定は消さず、無視するだけ)。
--   ・提供状態(feature_catalog.lifecycle)は google_reviews のものを使い続ける。全店舗に効く全体の切り替えとして残す
--     (GOOGLE_REVIEWS_OAUTH_ENABLED と合わせて、準備中に戻せる)。
--   ・利用区分(0025)の判定はそのまま。
-- 関数を作り直すだけで、表・データは変えない。何度実行しても同じ結果になる。

create or replace function public.salon_feature_access(p_salon_id uuid, p_feature_key text)
returns table (allowed boolean, reason text)
language sql
stable
set search_path = ''
as $$
  select
    b.allowed and public.salon_service_active(b.service_status),
    case when b.allowed and not public.salon_service_active(b.service_status) then 'service_pending' else b.reason end
  from (
    select
      s.service_status,
      case
        when c.feature_key is null then false
        when r.plan is null then false
        when c.lifecycle <> 'available' then false
        when o.mode = 'deny' then false
        when o.mode = 'allow' then true
        else r.default_enabled
      end as allowed,
      case
        when c.feature_key is null then 'unknown_feature'
        when r.plan is null then 'not_in_plan'
        when c.lifecycle <> 'available' then 'lifecycle_' || c.lifecycle
        when o.mode = 'deny' then 'override_deny'
        when o.mode = 'allow' then 'override_allow'
        when r.default_enabled then 'plan_default'
        else 'plan_default_off'
      end as reason
    from public.salons s
    left join public.feature_catalog c on c.feature_key = p_feature_key
    -- Google口コミは、プランと個別設定を口コミ(reviews)から読む
    left join public.plan_feature_rules r
      on r.plan = s.plan and r.feature_key = case when p_feature_key = 'google_reviews' then 'reviews' else p_feature_key end
    left join public.salon_feature_overrides o
      on o.salon_id = s.id and o.feature_key = case when p_feature_key = 'google_reviews' then 'reviews' else p_feature_key end
    where s.id = p_salon_id
  ) b;
$$;
