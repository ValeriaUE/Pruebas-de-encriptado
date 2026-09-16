-- =====================================================================
-- FN Inspección — Storage de fotos (ejecutar UNA vez en Supabase)
-- SQL Editor → pegar → Run
-- =====================================================================

-- 1) Bucket público para las fotos de inspección
insert into storage.buckets (id, name, public)
values ('inspection-photos', 'inspection-photos', true)
on conflict (id) do update set public = true;

-- 2) Permisos: lectura pública y subida desde la app (clave anon/publishable)
drop policy if exists "fn_photos_read"   on storage.objects;
drop policy if exists "fn_photos_insert" on storage.objects;
drop policy if exists "fn_photos_update" on storage.objects;

create policy "fn_photos_read" on storage.objects
  for select using (bucket_id = 'inspection-photos');

create policy "fn_photos_insert" on storage.objects
  for insert with check (bucket_id = 'inspection-photos');

create policy "fn_photos_update" on storage.objects
  for update using (bucket_id = 'inspection-photos')
  with check (bucket_id = 'inspection-photos');
