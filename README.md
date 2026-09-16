# FN Inspección — Despliegue en Vercel

Carpeta lista para publicar como sitio estático (instalable, con datos en la nube
vía Supabase). **Todos los nombres de archivo están en minúsculas y sin espacios**
para evitar problemas de rutas en Vercel.

## PASO 0 (OBLIGATORIO) — Crear las tablas en Supabase
La app guarda y comparte los datos en Supabase, así que **antes de usarla** hay
que crear las tablas:
1. Entra a tu proyecto en https://supabase.com
2. Menú **SQL Editor → New query**.
3. Pega el contenido de `../supabase/schema.sql` y presiona **Run**.
4. Crea una nueva query, pega el contenido de `../supabase/storage.sql` y **Run**
   (crea el bucket de fotos `inspection-photos`).
5. Listo: quedan creadas las 11 tablas, el bucket de fotos y sus permisos. La primera
   vez que abras la app, sembrará sola los 24 usuarios por defecto (clave `1111`).

> La app ya trae configurada la URL del proyecto y la **clave pública**
> (`sb_publishable_…`) en `supabase-sync.js`. Es la clave segura para el navegador.
> Si algún día rotas las claves, actualiza ese archivo.

## Opción A — Subir por la web (sin instalar nada)
1. Entra a https://vercel.com → **Add New… → Project**.
2. Elige **Deploy** sin framework (o arrastra esta carpeta en el importador).
3. En **Framework Preset** selecciona **Other**.
4. Deja **Root Directory** en esta carpeta. **Build Command:** vacío. **Output Directory:** vacío (o `.`).
5. Deploy. Listo.

## Opción B — Vercel CLI
```bash
npm i -g vercel
cd vercel-deploy
vercel        # despliegue de prueba
vercel --prod # producción
```

## Después de publicar
- Abre la URL **con internet la primera vez** para que se instale el service worker.
- En el celular: menú del navegador → **Agregar a pantalla de inicio**. Se instala como "FN Inspección".
- Una vez instalada, funciona **sin conexión**.

## Al publicar cambios
Sube el número de versión en `sw.js` (`const CACHE = 'fn-inspeccion-v1'` → `...-v2`)
para forzar la actualización del caché en los dispositivos ya instalados.

## Archivos
- `index.html` — la aplicación
- `supabase-sync.js` — puente de sincronización con Supabase (URL + clave pública)
- `manifest.webmanifest` — datos de instalación (nombre, íconos, colores)
- `sw.js` — service worker (cachea el shell; las llamadas a Supabase van siempre por red)
- `vercel.json` — cabeceras para que el service worker se actualice correctamente
- `icon-*.png`, `apple-touch-icon.png` — íconos de instalación
- `logo-neumaticos.png` — logo en la pantalla de inicio de sesión
- `acceso.js` — dirección y clave del proyecto Supabase (única configuración)
- `almacenamiento.js` — hace que los datos vivan solo en memoria, no en el equipo

**Todos los archivos van en la MISMA carpeta, sin subcarpetas.**

## Nota sobre "funciona sin internet"
Elegiste el modelo **solo nube**: la app necesita conexión para abrir (descarga los
datos al iniciar). Sin internet muestra una pantalla de "Reintentar". Si más adelante
quieres que también funcione offline con la última copia, se puede cambiar a modo híbrido.

## Nota
Se clonó el proyecto en el computador de Francisco.
