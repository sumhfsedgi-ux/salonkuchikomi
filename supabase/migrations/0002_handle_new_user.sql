-- Auto-create a profiles row whenever an owner account is created in
-- Supabase Auth (owner accounts are provisioned manually via the dashboard —
-- see README — there is no public signup flow in this app).

create function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function handle_new_user();
