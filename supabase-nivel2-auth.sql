-- =====================================================================
-- FN Inspección — Nivel 2 (por etapas): sesiones reales de Supabase Auth
--
-- PASO A (hacer ahora, en el panel — no es SQL):
--   Authentication → Users → "Add user" → Create new user
--     Email: vai.segovia.c@gmail.com
--     Password: 123456
--     ✅ marcar "Auto Confirm User"  (si no, pide confirmar por correo)
--   Y en la app (Usuarios) crear/editar un perfil con ESE MISMO correo,
--   con su rol y sucursal. El correo es lo que une ambas cosas.
--
-- PASO B (este SQL): dejar que las sesiones reales puedan trabajar.
--   Se AGREGAN permisos para el rol "authenticated" sin quitarle nada a
--   "anon", así los 31 usuarios que todavía entran por la tabla siguen
--   funcionando. Es seguro ejecutarlo cuantas veces quieras.
--
-- PASO C (SOLO cuando TODAS las personas tengan su cuenta en
--   Authentication y hayan entrado al menos una vez): descomentar el
--   bloque final para cerrar el acceso anónimo. Ese es el momento en que
--   los datos dejan de poder leerse sin sesión.
-- =====================================================================

-- ---------- PASO B ----------
do $$
declare t text;
begin
  foreach t in array array['users','vehicles','inspections','alerts','emails',
                           'announcements','quotes','recommendations','audit_log',
                           'suggestions','app_kv']
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "auth_select_%1$s" on public.%1$I', t);
    execute format('drop policy if exists "auth_write_%1$s"  on public.%1$I', t);
    execute format('drop policy if exists "auth_update_%1$s" on public.%1$I', t);
    execute format('drop policy if exists "auth_delete_%1$s" on public.%1$I', t);

    -- La tabla users NO se lee directo ni con sesión: se usa fn_users_public.
    if t <> 'users' then
      execute format('create policy "auth_select_%1$s" on public.%1$I for select to authenticated using (true)', t);
    end if;
    execute format('create policy "auth_write_%1$s"  on public.%1$I for insert to authenticated with check (true)', t);
    execute format('create policy "auth_update_%1$s" on public.%1$I for update to authenticated using (true) with check (true)', t);
    execute format('create policy "auth_delete_%1$s" on public.%1$I for delete to authenticated using (true)', t);

    execute format('grant insert, update, delete on public.%I to authenticated', t);
    if t <> 'users' then
      execute format('grant select on public.%I to authenticated', t);
    end if;
  end loop;
end $$;

grant execute on function public.fn_login(text, text) to authenticated;
grant execute on function public.fn_users_public()    to authenticated;

-- Las fotos también quedan disponibles para sesiones reales.
drop policy if exists "fn_photos_read_auth"   on storage.objects;
drop policy if exists "fn_photos_insert_auth" on storage.objects;
create policy "fn_photos_read_auth" on storage.objects
  for select to authenticated using (bucket_id = 'inspection-photos');
create policy "fn_photos_insert_auth" on storage.objects
  for insert to authenticated with check (bucket_id = 'inspection-photos');


-- ---------- PASO C · NO EJECUTAR TODAVÍA ----------
-- Cuando todas las personas tengan cuenta en Authentication, quita los
-- guiones de comentario de este bloque y ejecútalo. A partir de ese
-- momento, sin sesión no se lee ni se escribe nada.
--
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['users','vehicles','inspections','alerts','emails',
--                            'announcements','quotes','recommendations','audit_log',
--                            'suggestions','app_kv']
--   loop
--     execute format('revoke all on public.%I from anon', t);
--     execute format('drop policy if exists "anon_select_%1$s" on public.%1$I', t);
--     execute format('drop policy if exists "users_write_anon"  on public.users');
--     execute format('drop policy if exists "users_update_anon" on public.users');
--     execute format('drop policy if exists "users_delete_anon" on public.users');
--   end loop;
-- end $$;
-- revoke execute on function public.fn_login(text, text) from anon;
