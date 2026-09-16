/* ===== CONEXIÓN A LA NUBE =====
   Lo único que la app necesita configurado en un archivo: a qué proyecto
   Supabase se conecta. Todos los datos (usuarios, clientes, vehículos,
   servicios, catálogo, precios, sucursales y configuración) se guardan y se
   leen desde ahí; ver LEEME-datos.md.

   La clave es la publishable/anon: está pensada para ir en el navegador y no
   da acceso por sí sola — las políticas de la base deciden qué puede ver cada
   usuario según su sesión. */

window.FN_ACCESO = {
  supabaseUrl: 'https://kzsicwbnnjzlmvzxgykz.supabase.co/rest/v1/',
  supabaseKey: 'sb_publishable_P31FDpxlTA__hWsf2nfhvg_NRrk4rlC',
};
