/* ===== ALMACENAMIENTO EN MEMORIA =====
   La app no deja datos guardados en el equipo. Todo lo que antes se escribía en
   el navegador (clientes, vehículos, órdenes, servicios, catálogo, precios,
   sucursales, configuración) ahora vive SOLO en memoria mientras la pantalla
   está abierta: se llena con lo que baja de Supabase y se sincroniza hacia
   Supabase. Al cerrar la app, en el equipo no queda nada.

   Se guarda en el equipo únicamente lo necesario para no pedir la contraseña en
   cada recarga: la sesión iniciada. Nada más.

   Este archivo se carga ANTES de supabase-sync.js: la sincronización trabaja
   sobre esta memoria sin saber que no es el disco. */

(function () {
  'use strict';

  // Lo único que sobrevive al cierre: la sesión de quien está conectado.
  var PERSISTENTES = {
    'fn_auth_session': 1,
    'fn_app_token': 1,
    'fullneumaticos_current_user_v2': 1
  };

  var real = window.localStorage;
  var memoria = Object.create(null);

  // Solo se toca lo que es de esta app: nunca claves de otro origen compartido.
  function propia(key) { return /^(fullneumaticos_|fn_)/.test(key); }

  // Limpieza: borra del equipo los datos de la app que hubieran quedado
  // guardados por versiones anteriores. Solo se conserva la sesión.
  try {
    var borrar = [];
    for (var i = 0; i < real.length; i++) {
      var k = real.key(i);
      if (k && !PERSISTENTES[k] && propia(k)) borrar.push(k);
    }
    borrar.forEach(function (k) { try { real.removeItem(k); } catch (e) {} });
  } catch (e) {}

  function persistente(key) { return !!PERSISTENTES[key]; }

  var api = {
    getItem: function (key) {
      key = String(key);
      if (persistente(key)) { try { return real.getItem(key); } catch (e) { return null; } }
      return Object.prototype.hasOwnProperty.call(memoria, key) ? memoria[key] : null;
    },
    setItem: function (key, value) {
      key = String(key);
      if (persistente(key)) { try { real.setItem(key, String(value)); } catch (e) {} return; }
      memoria[key] = String(value);
    },
    removeItem: function (key) {
      key = String(key);
      if (persistente(key)) { try { real.removeItem(key); } catch (e) {} return; }
      delete memoria[key];
    },
    clear: function () {
      memoria = Object.create(null);
      try {
        var out = [];
        for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k && propia(k)) out.push(k); }
        out.forEach(function (k) { real.removeItem(k); });
      } catch (e) {}
    },
    key: function (n) {
      var keys = Object.keys(memoria);
      return n >= 0 && n < keys.length ? keys[n] : null;
    }
  };

  // Reemplaza los métodos sobre el propio objeto localStorage, para que todo el
  // código existente (y el interceptor de sincronización) siga funcionando igual.
  try {
    Object.defineProperty(window.localStorage, 'length', {
      configurable: true,
      get: function () { return Object.keys(memoria).length; }
    });
  } catch (e) {}
  ['getItem', 'setItem', 'removeItem', 'clear', 'key'].forEach(function (m) {
    try {
      Object.defineProperty(window.localStorage, m, {
        value: api[m], configurable: true, writable: true, enumerable: false
      });
    } catch (e) {
      try { window.localStorage[m] = api[m]; } catch (e2) {}
    }
  });

  // Aviso claro si el navegador no permitiera reemplazarlos.
  if (window.localStorage.getItem !== api.getItem) {
    console.error('[FN] No se pudo activar el almacenamiento en memoria: revisa almacenamiento.js');
  }

  window.FN_ALMACENAMIENTO = { modo: 'memoria', persistentes: Object.keys(PERSISTENTES) };
})();
