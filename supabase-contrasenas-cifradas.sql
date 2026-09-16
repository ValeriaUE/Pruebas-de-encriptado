-- =====================================================================
--  CONTRASEÑAS CIFRADAS  (Full Neumáticos)
--  Ejecutar UNA VEZ en Supabase → SQL Editor → Run.
--  Se puede volver a ejecutar sin riesgo (es idempotente).
--
--  Qué hace:
--   1. Habilita pgcrypto (cifrado bcrypt) en el proyecto.
--   2. Un disparador cifra la contraseña ANTES de guardarla en la tabla
--      users: no importa por dónde llegue (la app, fn_push, fn_users_upsert
--      o el editor de Supabase), en la base nunca queda texto plano.
--   3. Convierte a hash las contraseñas que hoy están en texto plano.
--   4. fn_login() valida contra el hash. Si encuentra una contraseña antigua
--      en texto plano, la acepta una última vez y la deja cifrada al pasar.
--
--  Importante: un hash NO se puede leer de vuelta. Después de esto, nadie
--  (ni el administrador, ni quien tenga acceso a la base) puede ver la
--  contraseña de un usuario: solo asignarle una nueva desde la app.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1) Helpers de cifrado
-- ---------------------------------------------------------------------

-- ¿El valor guardado ya es un hash bcrypt?
create or replace function public.fn_pwd_is_hash(p_stored text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_stored, '') ~ '^\$2[abxy]?\$[0-9]{2}\$';
$$;

-- Cifra una contraseña (bcrypt, coste 10). Si ya viene cifrada, la deja igual.
create or replace function public.fn_pwd_hash(p_plain text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_plain is null or p_plain = '' then
    return p_plain;
  end if;
  if public.fn_pwd_is_hash(p_plain) then
    return p_plain;
  end if;
  return extensions.crypt(p_plain, extensions.gen_salt('bf', 10));
end;
$$;

-- Compara lo ingresado con lo guardado (sirve para hash y para texto plano
-- antiguo, para no dejar afuera a nadie durante la transición).
create or replace function public.fn_pwd_matches(p_stored text, p_given text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_stored is null or p_stored = '' or p_given is null then
    return false;
  end if;
  if public.fn_pwd_is_hash(p_stored) then
    return extensions.crypt(p_given, p_stored) = p_stored;
  end if;
  return p_stored = p_given;   -- contraseña antigua sin cifrar
end;
$$;

-- ---------------------------------------------------------------------
-- 2) Disparador: cifrar al guardar + no perder la contraseña existente
--    (reemplaza al antiguo trg_users_keep_password)
-- ---------------------------------------------------------------------
create or replace function public.fn_users_password_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_new text := new.data ->> 'password';
  v_old text;
begin
  if tg_op = 'UPDATE' then
    v_old := old.data ->> 'password';
  end if;

  -- Sin contraseña en el registro que llega: se conserva la que ya estaba.
  if v_new is null or v_new = '' then
    if v_old is not null and v_old <> '' then
      new.data := new.data || jsonb_build_object('password', v_old);
    else
      new.data := new.data - 'password';
    end if;
    return new;
  end if;

  -- Contraseña nueva: se guarda cifrada (si ya viene cifrada, se deja igual).
  new.data := new.data || jsonb_build_object('password', public.fn_pwd_hash(v_new));
  return new;
end;
$$;

drop trigger if exists trg_users_keep_password on public.users;
drop trigger if exists trg_users_password_guard on public.users;
create trigger trg_users_password_guard
  before insert or update on public.users
  for each row execute function public.fn_users_password_guard();

-- ---------------------------------------------------------------------
-- 3) Cifrar de una vez las contraseñas que están en texto plano
-- ---------------------------------------------------------------------
update public.users u
   set data = u.data || jsonb_build_object('password', public.fn_pwd_hash(u.data ->> 'password'))
 where coalesce(u.data ->> 'password', '') <> ''
   and not public.fn_pwd_is_hash(u.data ->> 'password');

-- ---------------------------------------------------------------------
-- 4) fn_login: valida contra el hash y entrega token de sesión
--    (mantiene el comportamiento del blindaje: sin token si aún no existe
--     la tabla app_sessions)
-- ---------------------------------------------------------------------
create or replace function public.fn_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t      text := lower(btrim(coalesce(p_identifier, '')));
  rid    text := public.fn_norm_rut(coalesce(p_identifier, ''));
  r      record;
  v_token text;
begin
  for r in
    select u.id, u.data as d
      from public.users u
     where public.fn_norm_txt(u.data ->> 'email') = public.fn_norm_txt(t)
        or public.fn_norm_txt(u.data ->> 'name')  = public.fn_norm_txt(t)
        or (rid <> '' and public.fn_norm_rut(u.data ->> 'rut') = rid)
  loop
    if public.fn_pwd_matches(r.d ->> 'password', p_password) then

      if coalesce((r.d ->> 'active')::boolean, true) = false then
        return jsonb_build_object('ok', false, 'reason', 'inactive');
      end if;

      -- Si la contraseña seguía en texto plano, queda cifrada ahora.
      if not public.fn_pwd_is_hash(r.d ->> 'password') then
        update public.users
           set data = data || jsonb_build_object('password', public.fn_pwd_hash(p_password))
         where id = r.id;
      end if;

      if to_regclass('public.app_sessions') is not null then
        v_token := encode(extensions.gen_random_bytes(24), 'hex');
        execute 'insert into public.app_sessions (token, user_id, email, role, branch) values ($1,$2,$3,$4,$5)'
          using v_token, r.id, r.d ->> 'email', r.d ->> 'role', r.d ->> 'branch';
        return jsonb_build_object('ok', true, 'token', v_token, 'user', r.d - 'password');
      end if;

      return jsonb_build_object('ok', true, 'user', r.d - 'password');
    end if;
  end loop;

  return jsonb_build_object('ok', false, 'reason', 'bad');
end;
$$;

-- ---------------------------------------------------------------------
-- 5) Permisos
-- ---------------------------------------------------------------------
-- El navegador solo necesita fn_login. Los helpers de cifrado quedan
-- reservados para la base (nadie puede pedirle un hash desde la app).
revoke all on function public.fn_pwd_hash(text)          from anon, authenticated;
revoke all on function public.fn_pwd_matches(text, text) from anon, authenticated;
grant execute on function public.fn_login(text, text)    to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) Comprobación: ninguna fila debe quedar con contraseña sin cifrar
-- ---------------------------------------------------------------------
select count(*) filter (where coalesce(data ->> 'password', '') = '')                        as sin_contrasena,
       count(*) filter (where public.fn_pwd_is_hash(data ->> 'password'))                    as cifradas,
       count(*) filter (where coalesce(data ->> 'password', '') <> ''
                          and not public.fn_pwd_is_hash(data ->> 'password'))                as en_texto_plano
  from public.users;
