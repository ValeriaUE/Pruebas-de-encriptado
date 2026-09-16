# Datos de la app

`index.html` contiene **solo el funcionamiento** de la app: no trae usuarios,
clientes, vehículos, servicios ni precios escritos en su código.

**Toda la información vive en Supabase** y se administra desde la propia app.

## Archivos de configuración (en la raíz, junto a index.html)

| Archivo | Qué contiene |
|---|---|
| `acceso.js` | La dirección del proyecto Supabase y su clave pública. Es lo único que hay que cambiar para apuntar la app a otra base de datos. |
| `almacenamiento.js` | Hace que los datos vivan solo en memoria mientras la app está abierta: nada queda guardado en el equipo. Lo único que se conserva es la sesión iniciada, para no pedir la contraseña en cada recarga. |

## Dónde queda cada dato en Supabase

| Información | Tabla |
|---|---|
| Cuentas de usuario y contraseñas (inicio de sesión) | `users` — la contraseña se guarda **cifrada** (bcrypt): no se puede ver, solo asignar una nueva. Ejecutar una vez `supabase-contrasenas-cifradas.sql` para activarlo. |
| Clientes y vehículos (el cliente es parte de la ficha de su vehículo) | `vehicles` |
| Órdenes de servicio e inspecciones | `inspections` |
| Alertas, correos, cotizaciones, recomendaciones, avisos, sugerencias, auditoría | `alerts`, `emails`, `quotes`, `recommendations`, `announcements`, `suggestions`, `audit_log` |
| Servicios, catálogo de productos y precios, sucursales, paquetes de mantención, comisiones y metas, configuración | `app_kv` (una fila por lista: `services`, `products`, `service_prices`, `price_categories`, `branches`, `service_groups`, `service_meta`, `service_packages`, `commissions`, `commission_users`, `pdf_prices`) |

## Notas

- **No queda nada guardado en el equipo.** Lo que baja de la nube se mantiene en
  memoria mientras la pantalla está abierta y se sincroniza hacia Supabase; al
  cerrar o recargar, se vuelve a pedir a la nube.
- Como consecuencia, **la app necesita conexión**: sin internet no hay datos que
  mostrar, y un registro hecho justo al perder la señal se pierde si se cierra
  la app antes de que vuelva.
- Si la nube no responde, la app lo avisa en pantalla y no inventa datos.
- Al publicar cambios, subir el número de versión de `CACHE` en `sw.js` para
  que los equipos ya instalados descarguen la versión nueva.
