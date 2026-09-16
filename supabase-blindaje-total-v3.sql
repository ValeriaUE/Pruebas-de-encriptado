-- =====================================================================
-- FN Inspección · BLINDAJE TOTAL (Etapa 2)
--
-- Problema que resuelve: hoy cualquiera puede abrir el inspector del
-- navegador (o llamar la API con la clave publishable) y leer vehículos,
-- clientes, inspecciones, cotizaciones y correos SIN iniciar sesión.
--
-- Cómo lo resuelve:
--   1. Se crea una tabla de sesiones (app_sessions) y fn_login entrega un
--      TOKEN al ingresar.
--   2. Toda lectura/escritura pasa por funciones (fn_pull / fn_push /
--      fn_remove / fn_kv_pull / fn_kv_push) que EXIGEN token válido
--      (o una sesión real de Supabase Auth).
--   3. Se le quitan TODOS los permisos a anon y authenticated sobre las
--      tablas. Sin sesión la API devuelve 401/permiso denegado: no hay
--      nada que ver en el inspector.
--   4. El informe por QR sigue siendo público, pero con fn_report_public:
--      entrega UNA inspección y su vehículo, nada más.
--
-- ORDEN DE EJECUCIÓN
--   PARTE 1  → se puede ejecutar con la app abierta.
--   PARTE 2  → CIERRA la app en todos los dispositivos (incluida la PWA
--              del teléfono) y ejecútala sola. Si sale "deadlock" o
--              "lock timeout": espera 15 s y repite.
--   Sube primero la versión nueva de la app (supabase-sync.js), porque
--   después de la PARTE 2 la versión vieja ya no podrá leer nada.
-- =====================================================================


-- =====================  PARTE 1 · sesiones y puerta  =================

create table if not exists public.app_sessions (
  token      text primary key,
  user_id    text not null,
  email      text,
  role       text,
  branch     text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  last_seen  timestamptz not null default now()
);
create index if not exists app_sessions_user_idx on public.app_sessions (user_id);

-- Normalizadores (por si este script se ejecuta antes que los anteriores)
create or replace function public.fn_norm_txt(s text)
returns text language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'));
$$;

create or replace function public.fn_norm_rut(s text)
returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(s, ''), '[^0-9kK]', '', 'g'));
$$;

-- Tablas que la app puede sincronizar (lista blanca: nada fuera de aquí)
create or replace function public.fn_tbl_ok(t text)
returns boolean language sql immutable as $$
  select t in ('users','vehicles','inspections','alerts','emails',
               'announcements','quotes','recommendations','audit_log','suggestions');
$$;

-- ---------------------------------------------------------------------
-- LA PUERTA: devuelve el perfil del usuario de la sesión o falla.
-- Acepta (a) token de la app, (b) sesión real de Supabase Auth (JWT).
-- ---------------------------------------------------------------------
create or replace function public.fn_guard(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   text;
  v       jsonb;
  v_email text;
  v_claim json;
begin
  if p_token is not null and p_token <> '' then
    update public.app_sessions s
       set last_seen = now()
     where s.token = p_token
       and s.expires_at > now()
    returning s.user_id into v_uid;

    if v_uid is not null then
      select u.data - 'password' into v from public.users u where u.id = v_uid;
      if v is not null and coalesce((v ->> 'active')::boolean, true) then
        return v;
      end if;
    end if;
  end if;

  begin
    v_claim := nullif(current_setting('request.jwt.claims', true), '')::json;
  exception when others then v_claim := null;
  end;

  if v_claim is not null and coalesce(v_claim ->> 'role', '') = 'authenticated' then
    v_email := fn_norm_txt(v_claim ->> 'email');
    if v_email <> '' then
      select u.data - 'password' into v
        from public.users u
       where fn_norm_txt(u.data ->> 'email') = v_email
       limit 1;
      if v is not null and coalesce((v ->> 'active')::boolean, true) then
        return v;
      end if;
    end if;
  end if;

  raise exception 'SESION_REQUERIDA' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------
-- Ingreso: valida en el servidor y entrega token de sesión.
-- Devuelve { ok:true, token, user:{...} } | { ok:false, reason:'bad'|'inactive' }
-- ---------------------------------------------------------------------
create or replace function public.fn_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  ident   text := fn_norm_txt(p_identifier);
  rid     text := fn_norm_rut(p_identifier);
  v_token text;
begin
  delete from public.app_sessions where expires_at < now();

  for r in
    select u.id, u.data as d
      from public.users u
     where fn_norm_txt(u.data ->> 'email') = ident
        or fn_norm_txt(u.data ->> 'name')  = ident
        or (rid <> '' and fn_norm_rut(u.data ->> 'rut') = rid)
  loop
    if (r.d ->> 'password') = p_password then
      if coalesce((r.d ->> 'active')::boolean, true) = false then
        return jsonb_build_object('ok', false, 'reason', 'inactive');
      end if;
      v_token := replace(gen_random_uuid()::text, '-', '') ||
                 replace(gen_random_uuid()::text, '-', '');
      insert into public.app_sessions (token, user_id, email, role, branch)
      values (v_token, r.id, r.d ->> 'email', r.d ->> 'role', r.d ->> 'branch');
      return jsonb_build_object('ok', true, 'token', v_token, 'user', r.d - 'password');
    end if;
  end loop;

  return jsonb_build_object('ok', false, 'reason', 'bad');
end;
$$;

create or replace function public.fn_logout(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.app_sessions where token = p_token;
$$;

-- ---------------------------------------------------------------------
-- Lectura: una tabla completa (o solo lo cambiado desde p_since).
-- Sin sesión válida NO devuelve nada: lanza error de permiso.
-- ---------------------------------------------------------------------
create or replace function public.fn_pull(p_token text, p_table text, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me    jsonb;
  v_sel text;
  out   jsonb;
begin
  me := fn_guard(p_token);
  if not fn_tbl_ok(p_table) then
    raise exception 'TABLA_NO_PERMITIDA: %', p_table using errcode = '42501';
  end if;

  -- Las contraseñas NUNCA salen de la base.
  v_sel := case when p_table = 'users' then 't.data - ''password''' else 't.data' end;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', t.id, ''data'', %s, ''updated_at'', t.updated_at) order by t.updated_at), ''[]''::jsonb)
       from public.%I t
      where ($1 is null or t.updated_at >= $1)', v_sel, p_table)
    into out using p_since;

  return coalesce(out, '[]'::jsonb);
end;
$$;

-- Escritura (crear / actualizar) ---------------------------------------
create or replace function public.fn_push(p_token text, p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me     jsonb;
  r      jsonb;
  n      integer := 0;
  v_data jsonb;
  v_old  jsonb;
begin
  me := fn_guard(p_token);
  if not fn_tbl_ok(p_table) then
    raise exception 'TABLA_NO_PERMITIDA: %', p_table using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_data := r -> 'data';
    if v_data is null or (r ->> 'id') is null then continue; end if;

    -- La app no conoce las contraseñas: si el registro llega sin ella, se conserva.
    if p_table = 'users' then
      if (v_data ->> 'password') is null or (v_data ->> 'password') = '' then
        select u.data into v_old from public.users u where u.id = (r ->> 'id');
        if v_old is not null and (v_old ->> 'password') is not null then
          v_data := v_data || jsonb_build_object('password', v_old ->> 'password');
        end if;
      end if;
    end if;

    execute format(
      'insert into public.%I (id, data, updated_at) values ($1, $2, $3)
         on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at',
      p_table)
      using (r ->> 'id'), v_data, coalesce((r ->> 'updated_at')::timestamptz, now());
    n := n + 1;
  end loop;

  return n;
end;
$$;

-- Borrado --------------------------------------------------------------
create or replace function public.fn_remove(p_token text, p_table text, p_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare me jsonb; n integer;
begin
  me := fn_guard(p_token);
  if not fn_tbl_ok(p_table) then
    raise exception 'TABLA_NO_PERMITIDA: %', p_table using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then return 0; end if;

  execute format('delete from public.%I where id = any($1)', p_table) using p_ids;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Configuración / listas (app_kv) --------------------------------------
create or replace function public.fn_kv_pull(p_token text, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare me jsonb; out jsonb;
begin
  me := fn_guard(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'value', k.value, 'updated_at', k.updated_at)
                            order by k.updated_at), '[]'::jsonb)
    into out
    from public.app_kv k
   where (p_since is null or k.updated_at >= p_since);
  return coalesce(out, '[]'::jsonb);
end;
$$;

create or replace function public.fn_kv_push(p_token text, p_key text, p_value jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare me jsonb;
begin
  me := fn_guard(p_token);
  if p_key is null or p_key = '' then return 0; end if;
  insert into public.app_kv (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  return 1;
end;
$$;

-- ---------------------------------------------------------------------
-- Informe por QR: lo ÚNICO público. Entrega una inspección y su vehículo.
-- ---------------------------------------------------------------------
create or replace function public.fn_report_public(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_insp jsonb; v_plate text; v_veh jsonb;
begin
  if p_id is null or p_id = '' then
    return jsonb_build_object('inspection', null, 'vehicle', null);
  end if;
  select i.data into v_insp from public.inspections i where i.id = p_id;
  if v_insp is null then
    return jsonb_build_object('inspection', null, 'vehicle', null);
  end if;
  v_plate := upper(coalesce(v_insp ->> 'licensePlate', v_insp ->> 'plate', v_insp ->> 'vehicleId', ''));
  if v_plate <> '' then
    select v.data into v_veh from public.vehicles v where upper(v.id) = v_plate;
  end if;
  return jsonb_build_object('inspection', v_insp, 'vehicle', v_veh);
end;
$$;


-- =====================  PARTE 2 · cerrar TODO  =======================
-- ⚠️  CIERRA LA APP EN TODOS LOS DISPOSITIVOS antes de ejecutar esto.
-- Ejecuta desde aquí hasta el final, seleccionando solo estas líneas.

set lock_timeout = '15s';

do $$
declare
  t   text;
  p   record;
  tbl text[] := array['users','vehicles','inspections','alerts','emails',
                      'announcements','quotes','recommendations','audit_log',
                      'suggestions','app_kv','app_sessions'];
begin
  foreach t in array tbl loop
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t) then
      -- 1) fuera todas las políticas (cualquier política = puerta abierta)
      for p in select policyname from pg_policies
                where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      -- 2) RLS activo sin políticas = nadie entra por la API directa.
      --    (NO se usa "force row level security": las funciones puente son
      --     SECURITY DEFINER y correrían como dueño; con FORCE quedarían sin
      --     poder leer ni escribir y la app se quedaría sin datos.)
      execute format('alter table public.%I enable row level security', t);
      -- 3) sin permisos para las claves públicas del navegador
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- Funciones antiguas que dejaban leer/escribir usuarios sin sesión: se cierran.
do $$
begin
  begin revoke execute on function public.fn_users_public()       from anon, authenticated; exception when others then null; end;
  begin revoke execute on function public.fn_users_upsert(jsonb)  from anon, authenticated; exception when others then null; end;
  begin revoke execute on function public.fn_users_delete(text[]) from anon, authenticated; exception when others then null; end;
end $$;

-- Lo único que el navegador puede llamar:
grant execute on function public.fn_login(text, text)                       to anon, authenticated;
grant execute on function public.fn_logout(text)                            to anon, authenticated;
grant execute on function public.fn_report_public(text)                     to anon, authenticated;
grant execute on function public.fn_pull(text, text, timestamptz)           to anon, authenticated;
grant execute on function public.fn_push(text, text, jsonb)                 to anon, authenticated;
grant execute on function public.fn_remove(text, text, text[])              to anon, authenticated;
grant execute on function public.fn_kv_pull(text, timestamptz)              to anon, authenticated;
grant execute on function public.fn_kv_push(text, text, jsonb)              to anon, authenticated;

-- fn_guard no se expone: solo la usan las funciones de arriba.
revoke all on function public.fn_guard(text) from anon, authenticated;


-- =====================  COMPROBACIÓN  ================================
-- 1) No debe quedar ninguna política:
--    select tablename, policyname from pg_policies where schemaname='public';
-- 2) No debe quedar ningún permiso de anon/authenticated en las tablas:
--    select table_name, grantee, privilege_type
--      from information_schema.role_table_grants
--     where table_schema='public' and grantee in ('anon','authenticated');
-- 3) Prueba desde el navegador en incógnito (sin sesión): pedir
--    /rest/v1/vehicles?select=* debe responder 401 o "permission denied".
