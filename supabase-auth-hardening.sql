-- =====================================================================
-- FN Inspección — Nivel 1 de seguridad: las contraseñas salen del navegador
-- SQL Editor de Supabase → pegar TODO → Run (una sola vez)
--
-- Qué hace:
--   1. Normaliza users.data a jsonb.
--   2. Un disparador evita perder la contraseña cuando la app guarda un
--      usuario sin ella (la app ya no la conoce).
--   3. fn_login(): valida el ingreso DENTRO de Supabase y devuelve el perfil
--      SIN contraseña (excepción: vsegovia@ultraestetica.cl).
--   4. fn_users_public(): la lista de usuarios que lee la app, sin contraseñas.
--   5. Se quita el permiso de LECTURA directa de la tabla users al público:
--      la app ya no puede descargar contraseñas ni con la clave publishable.
-- =====================================================================

-- 1) data como jsonb -----------------------------------------------------
do $$
declare t text;
begin
  select data_type into t from information_schema.columns
   where table_schema = 'public' and table_name = 'users' and column_name = 'data';
  if t = 'json' then
    execute 'alter table public.users alter column data type jsonb using data::jsonb';
  end if;
end $$;

-- 2) No perder la contraseña en las ediciones ----------------------------
create or replace function public.fn_users_keep_password()
returns trigger
language plpgsql
as $$
begin
  if (new.data ->> 'password') is null or (new.data ->> 'password') = '' then
    if tg_op = 'UPDATE' and (old.data ->> 'password') is not null then
      new.data := new.data || jsonb_build_object('password', old.data ->> 'password');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_keep_password on public.users;
create trigger trg_users_keep_password
  before insert or update on public.users
  for each row execute function public.fn_users_keep_password();

-- Helpers de comparación (mismo criterio que usaba la app) ---------------
create or replace function public.fn_norm_txt(s text)
returns text language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'));
$$;

create or replace function public.fn_norm_rut(s text)
returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(s, ''), '[^0-9kK]', '', 'g'));
$$;

-- 3) Ingreso validado en el servidor ------------------------------------
-- Devuelve { ok: true, user: {...} }  |  { ok: false, reason: 'inactive' | 'bad' }
create or replace function public.fn_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r     record;
  ident text := fn_norm_txt(p_identifier);
  rid   text := fn_norm_rut(p_identifier);
  hit   boolean := false;
begin
  for r in
    select u.data as d
      from public.users u
     where fn_norm_txt(u.data ->> 'email') = ident
        or fn_norm_txt(u.data ->> 'name')  = ident
        or (rid <> '' and fn_norm_rut(u.data ->> 'rut') = rid)
  loop
    hit := true;
    if (r.d ->> 'password') = p_password then
      if coalesce((r.d ->> 'active')::boolean, true) = false then
        return jsonb_build_object('ok', false, 'reason', 'inactive');
      end if;
      -- Única cuenta autorizada a recibir su contraseña en el navegador.
      if fn_norm_txt(r.d ->> 'email') = 'vsegovia@ultraestetica.cl' then
        return jsonb_build_object('ok', true, 'user', r.d);
      end if;
      return jsonb_build_object('ok', true, 'user', r.d - 'password');
    end if;
  end loop;

  if hit then
    return jsonb_build_object('ok', false, 'reason', 'bad');
  end if;
  return jsonb_build_object('ok', false, 'reason', 'bad');
end;
$$;

-- 4) Lista de usuarios para la app, sin contraseñas ---------------------
create or replace function public.fn_users_public()
returns table (id text, data jsonb, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select u.id::text,
         case when fn_norm_txt(u.data ->> 'email') = 'vsegovia@ultraestetica.cl'
              then u.data
              else u.data - 'password' end,
         u.updated_at
    from public.users u;
$$;

-- 5) Permisos ------------------------------------------------------------
-- La app SIGUE pudiendo crear / editar / borrar usuarios, pero ya NO puede
-- leer la tabla directamente: la lectura pasa por las funciones de arriba.
alter table public.users enable row level security;

drop policy if exists "users_select_anon" on public.users;
drop policy if exists "users_all_anon"    on public.users;
drop policy if exists "users_write_anon"  on public.users;
drop policy if exists "Enable read access for all users" on public.users;

create policy "users_write_anon" on public.users
  for insert to anon, authenticated with check (true);
create policy "users_update_anon" on public.users
  for update to anon, authenticated using (true) with check (true);
create policy "users_delete_anon" on public.users
  for delete to anon, authenticated using (true);
-- (a propósito NO existe una política de SELECT: nadie lee la tabla directo)

revoke select on public.users from anon, authenticated;
grant insert, update, delete on public.users to anon, authenticated;

grant execute on function public.fn_login(text, text)   to anon, authenticated;
grant execute on function public.fn_users_public()      to anon, authenticated;
grant execute on function public.fn_norm_txt(text)      to anon, authenticated;
grant execute on function public.fn_norm_rut(text)      to anon, authenticated;
