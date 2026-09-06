-- Optional free-text "business type" (業種, e.g. ヘアサロン / エステサロン / 整体院),
-- passed to the AI review-generation prompt as background context only —
-- never a source of facts for review content (see app/api/generate-review/route.ts).
-- Nullable: not every salon sets one. Auto-defaulted from the chosen survey
-- template's name on first survey creation without ever overwriting an
-- owner-provided value (see lib/supabase/queries.ts#applyDefaultBusinessType).

alter table salons
  add column business_type text
    check (business_type is null or char_length(business_type) between 1 and 100);

-- create or replace view requires the full column list restated, not just
-- the new column. Column order matches PublicSalon in lib/types.ts.
create or replace view salon_public
with (security_invoker = false) as
select id, name, slug, google_review_url, description, business_type
from salons;

grant select on salon_public to anon, authenticated;
