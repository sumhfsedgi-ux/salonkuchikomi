-- Explicit "has this salon's owner finished the onboarding wizard" flag.
-- Needed because the wizard's step 3/4 must survive a Server Action-triggered
-- re-render of /admin mid-flow (see app/admin/(authed)/page.tsx) -- the
-- presence of a `surveys` row alone is reached too early (right after
-- template selection, before the Google review URL step), so it cannot be
-- used as the "onboarding is done" signal.

alter table salons
  add column onboarding_completed boolean not null default false;
