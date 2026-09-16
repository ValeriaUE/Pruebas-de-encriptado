-- =====================================================================
-- FN Inspección — Arreglo: volver a poder GUARDAR usuarios
--   Ejecutar en SQL Editor. Reemplaza al bloque de permisos anterior.
--
-- Por qué: al hacer REVOKE SELECT, Postgres también rechaza el
-- "insertar o actualizar" (ON CONFLICT) y los borrados con filtro, que es
-- como la app guarda los usuarios.
--
-- Solución correcta (patrón estándar de Supabase): se devuelve el permiso
-- técnico de SELECT, pero NO se crea ninguna política de lectura. Resultado:
--   · leer la tabla directamente devuelve CERO filas (nada de contraseñas),
--   · crear, editar y borrar usuarios vuelve a funcionar,
--   · la app sigue leyendo la lista por fn_users_public (sin contraseñas).
-- =====================================================================

grant select, insert, update, delete on public.users to anon, authenticated;

alter table public.users enable row level security;

-- Ninguna política de SELECT: sin política, la lectura no devuelve nada.
drop policy if exists "users_select_anon"                on public.users;
drop policy if exists "users_select_auth"                on public.users;
drop policy if exists "auth_select_users"                on public.users;
drop policy if exists "Enable read access for all users" on public.users;

-- Escritura permitida (la app administra los usuarios).
drop policy if exists "users_write_anon"  on public.users;
drop policy if exists "users_update_anon" on public.users;
drop policy if exists "users_delete_anon" on public.users;

create policy "users_write_anon" on public.users
  for insert to anon, authenticated with check (true);
create policy "users_update_anon" on public.users
  for update to anon, authenticated using (true) with check (true);
create policy "users_delete_anon" on public.users
  for delete to anon, authenticated using (true);

-- Comprobación rápida (debe devolver 0 filas):
--   select * from public.users;   ← ejecutado como anon desde la app
