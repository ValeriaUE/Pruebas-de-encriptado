-- =====================================================================
-- FN Inspección — Usuarios cerrados · versión en 2 partes
--
-- El error "deadlock detected" ocurre porque la app estaba abierta
-- consultando la tabla mientras el SQL intentaba cambiarle los permisos.
--
-- CIERRA PRIMERO la app en todos los dispositivos y pestañas
-- (incluida la PWA del teléfono). Después ejecuta la PARTE 1 y la PARTE 2.
-- =====================================================================


-- =====================  PARTE 1 · funciones  =========================
-- No toca permisos, no se bloquea. Se puede ejecutar con la app abierta.

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
      set data = excluded.data, updated_at = excluded.updated_at;
    n := n + 1;
  end loop;
  return n;
end;
$$;

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

grant execute on function public.fn_users_public()       to anon, authenticated;
grant execute on function public.fn_login(text, text)    to anon, authenticated;
grant execute on function public.fn_users_upsert(jsonb)  to anon, authenticated;
grant execute on function public.fn_users_delete(text[]) to anon, authenticated;


-- =====================  PARTE 2 · cerrar la tabla  ===================
-- ⚠️  CIERRA LA APP EN TODOS LOS DISPOSITIVOS antes de ejecutar esto.
-- Si vuelve a dar "deadlock" o "lock timeout": espera 15 segundos y repite.
-- Ejecútala SOLA (selecciona solo estas líneas y presiona Run).

set lock_timeout = '15s';

drop policy if exists fn_anon_all         on public.users;
drop policy if exists users_write_anon    on public.users;
drop policy if exists users_update_anon   on public.users;
drop policy if exists users_delete_anon   on public.users;
drop policy if exists users_select_anon   on public.users;
drop policy if exists auth_select_users   on public.users;
drop policy if exists auth_write_users    on public.users;
drop policy if exists auth_update_users   on public.users;
drop policy if exists auth_delete_users   on public.users;

alter table public.users enable row level security;
revoke all on public.users from anon, authenticated;


-- =====================  COMPROBACIÓN  ================================
-- Debe devolver 0 filas: si sale alguna, quedó una política de lectura.
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'public' and tablename = 'users';
