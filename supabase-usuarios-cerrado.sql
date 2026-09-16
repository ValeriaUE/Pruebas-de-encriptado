-- =====================================================================
-- FN Inspección — Usuarios: tabla CERRADA, lectura y escritura por función
--   Ejecutar en SQL Editor. Sustituye a supabase-fix-guardar-usuarios.sql
--   (ese archivo abrió la lectura de nuevo; este la cierra de verdad).
--
-- Resultado:
--   · La app no tiene NINGÚN permiso sobre la tabla users.
--   · Lee la lista con fn_users_public()  → sin contraseñas.
--   · Crea / edita con fn_users_upsert()  → sin necesitar lectura.
--   · Borra con fn_users_delete().
--   · El ingreso se valida con fn_login().
-- =====================================================================

-- 1) Guardar (crear o actualizar) varios usuarios de una vez ------------
create or replace function public.fn_users_upsert(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      jsonb;
  n      integer := 0;
  v_old  jsonb;
  v_data jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_data := r -> 'data';
    if v_data is null or (r ->> 'id') is null then
      continue;
    end if;

    select u.data into v_old from public.users u where u.id = (r ->> 'id');

    -- La app ya no conoce las contraseñas: si el registro llega sin ella,
    -- se conserva la que está guardada.
    if (v_data ->> 'password') is null or (v_data ->> 'password') = '' then
      if v_old is not null and (v_old ->> 'password') is not null then
        v_data := v_data || jsonb_build_object('password', v_old ->> 'password');
      end if;
    end if;

    insert into public.users (id, data, updated_at)
    values (r ->> 'id', v_data, coalesce((r ->> 'updated_at')::timestamptz, now()))
    on conflict (id) do update
      set data = excluded.data,
          updated_at = excluded.updated_at;
    n := n + 1;
  end loop;

  return n;
end;
$$;

-- 2) Borrar usuarios ----------------------------------------------------
create or replace function public.fn_users_delete(p_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  delete from public.users where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 3) Cerrar la tabla: la app no la toca nunca más -----------------------
alter table public.users enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'users'
  loop
    execute format('drop policy if exists %I on public.users', p.policyname);
  end loop;
end $$;

revoke all on public.users from anon, authenticated;

grant execute on function public.fn_users_public()            to anon, authenticated;
grant execute on function public.fn_login(text, text)         to anon, authenticated;
grant execute on function public.fn_users_upsert(jsonb)       to anon, authenticated;
grant execute on function public.fn_users_delete(text[])      to anon, authenticated;

-- Comprobación: esto debe fallar con "permission denied" desde la app
--   select * from public.users;
