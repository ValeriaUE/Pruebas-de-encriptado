/* ============================================================
   FN Inspección — Puente de sincronización con Supabase
   ------------------------------------------------------------
   Estrategia: el almacenamiento local del navegador sigue siendo
   la caché que la app lee de forma síncrona, pero:
     1) al ARRANCAR se hidrata desde Supabase (nube = fuente de verdad);
     2) cada ESCRITURA local se espeja automáticamente a Supabase.
   Así los datos se comparten entre todos los dispositivos sin
   reescribir la lógica de la aplicación.
   ============================================================ */
(function () {
  'use strict';

  // Credenciales de conexión: se definen en acceso.js (cargado antes que este archivo).
  var FN_ACCESO = (typeof window !== 'undefined' && window.FN_ACCESO) || {};
  var SUPABASE_URL = FN_ACCESO.supabaseUrl || '';
  var SUPABASE_KEY = FN_ACCESO.supabaseKey || '';
  if (!SUPABASE_URL || !SUPABASE_KEY) console.error('[FN] Faltan credenciales: revisa acceso.js');

  // Colecciones: una fila por registro en su tabla.
  // (clave de localStorage) -> { tabla, campo que actúa de id }
  var COLLECTIONS = {
    // Los usuarios se LEEN por función (fn_users_public) para que las contraseñas
    // no salgan nunca al navegador. Las escrituras siguen yendo a la tabla.
    'fullneumaticos_users_v3':        { table: 'users',           idField: 'id', readRpc: 'fn_users_public' },
    'fullneumaticos_vehicles':        { table: 'vehicles',        idField: 'licensePlate' },
    'fullneumaticos_inspections':     { table: 'inspections',     idField: 'id' },
    'fullneumaticos_alerts':          { table: 'alerts',          idField: 'id' },
    'fullneumaticos_emails':          { table: 'emails',          idField: 'id' },
    'fullneumaticos_announcements':   { table: 'announcements',    idField: 'id' },
    'fullneumaticos_quotes':          { table: 'quotes',          idField: 'id' },
    'fullneumaticos_recommendations': { table: 'recommendations', idField: 'id' },
    'fullneumaticos_audit_log':       { table: 'audit_log',       idField: 'id' },
    'fullneumaticos_suggestions':     { table: 'suggestions',     idField: 'id' }
  };

  // Configuración / listas: tabla clave-valor app_kv.
  // (clave de localStorage) -> (clave en app_kv)
  var KV = {
    'fullneumaticos_branches':         'branches',
    'fullneumaticos_services':         'services',
    'fullneumaticos_service_prices':   'service_prices',
    'fullneumaticos_products':         'products',
    'fullneumaticos_price_categories': 'price_categories',
    'fullneumaticos_commissions':      'commissions',
    'fullneumaticos_commission_users': 'commission_users',
    'fullneumaticos_ann_read':         'ann_read',
    'fullneumaticos_service_meta':     'service_meta',
    'fullneumaticos_service_groups':   'service_groups',
    'fullneumaticos_service_packages': 'service_packages',
    'fullneumaticos_pdf_prices':       'pdf_prices'
  };

  // ---------------- Sesión de Supabase Auth (opcional, por usuario) ----------------
  // Si hay sesión, TODAS las peticiones van firmadas con el token del usuario, así
  // las políticas RLS pueden distinguir quién pide qué. Sin sesión se usa la clave
  // publishable (comportamiento anterior), para no romper a quien aún no migra.
  var AUTH_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '/') + 'auth/v1/';
  var SESSION_KEY = 'fn_auth_session';
  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }

  // ---------------- Token de sesión de la app (puerta de la base) ----------------
  // Sin este token (o sin sesión real de Supabase Auth) la base no entrega NADA:
  // las tablas no tienen permisos y todo pasa por funciones que exigen sesión.
  var TOKEN_KEY = 'fn_app_token';
  var appToken = '';
  try { appToken = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { appToken = ''; }
  function setToken(t) {
    appToken = t || '';
    try { if (appToken) localStorage.setItem(TOKEN_KEY, appToken); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  function hasSession() { return !!(appToken || (session && session.access_token)); }

  // ¿La base ya tiene instalado el SQL de blindaje? Se pregunta UNA vez.
  // Si no lo tiene, la app sigue funcionando por el camino antiguo (así no se
  // queda sin datos por haber subido la app antes de ejecutar el SQL).
  var gateProbe = null;
  function probeGate() {
    if (gateProbe) return gateProbe;
    gateProbe = fetch(SUPABASE_URL + 'rpc/fn_pull', {
      method: 'POST', headers: baseHeaders(),
      body: JSON.stringify({ p_token: appToken || '', p_table: 'users', p_since: null })
    }).then(function (res) {
      if (res.status === 404) { gateMissing = true; return false; }
      return res.text().then(function (txt) {
        if (/PGRST202|could not find the function/i.test(txt)) { gateMissing = true; return false; }
        return true;
      });
    }).catch(function () { return true; });  // sin red: se asume instalada
    return gateProbe;
  }

  // Puerta única: todas las lecturas y escrituras van por estas funciones.
  // gateMissing = la base todavía no tiene el SQL de blindaje instalado.
  var gateMissing = false;
  var sessionLost = false;
  function sessionExpired() {
    if (sessionLost) return;
    sessionLost = true;
    setToken('');
    try { window.dispatchEvent(new Event('fnsync:session-expired')); } catch (e) {}
  }
  async function gate(name, body) {
    var res = await fetch(SUPABASE_URL + 'rpc/' + name, {
      method: 'POST', headers: baseHeaders(), body: JSON.stringify(body)
    });
    if (res.ok) return await res.json().catch(function () { return null; });
    var txt = await res.text();
    if (res.status === 404 || /PGRST202|could not find the function/i.test(txt)) {
      gateMissing = true;
      var em = new Error('GATE_MISSING ' + name);
      em.missing = true;
      throw em;
    }
    if (/SESION_REQUERIDA/.test(txt) || res.status === 401) {
      sessionExpired();
      var es = new Error('Su sesión expiró. Vuelva a iniciar sesión.');
      es.sessionRequired = true;
      throw es;
    }
    throw new Error(name + ' → ' + res.status + ' ' + txt.slice(0, 200));
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }
  function bearer() {
    if (session && session.access_token && (!session.expires_at || session.expires_at * 1000 > Date.now() + 30000)) {
      return session.access_token;
    }
    return SUPABASE_KEY;
  }
  function baseHeaders(pref) {
    var h = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + bearer(),
      'Content-Type': 'application/json'
    };
    if (pref) h['Prefer'] = pref;
    return h;
  }
  function withPrefer(pref) { return baseHeaders(pref); }

  // Renueva el token si está por expirar (sesiones de Supabase duran 1 hora).
  async function refreshSession() {
    if (!session || !session.refresh_token) return false;
    if (session.expires_at && session.expires_at * 1000 > Date.now() + 120000) return true;
    try {
      var res = await fetch(AUTH_URL + 'token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!res.ok) { saveSession(null); return false; }
      var s = await res.json();
      saveSession({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, email: (s.user && s.user.email) || (session && session.email) });
      return true;
    } catch (e) { return false; }
  }

  // Ingreso con cuenta real de Supabase (Authentication → Users).
  async function authSignIn(email, password) {
    var res = await fetch(AUTH_URL + 'token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), password: password })
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      return { ok: false, code: body.error_code || body.code || res.status, message: body.msg || body.error_description || body.error || ('HTTP ' + res.status) };
    }
    saveSession({ access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at, email: body.user && body.user.email });
    sessionLost = false;
    return { ok: true, email: body.user && body.user.email, user: body.user };
  }
  function authSignOut() {
    if (session && session.access_token) {
      fetch(AUTH_URL + 'logout', { method: 'POST', headers: baseHeaders() }).catch(function () {});
    }
    if (appToken) {
      fetch(SUPABASE_URL + 'rpc/fn_logout', {
        method: 'POST', headers: baseHeaders(), body: JSON.stringify({ p_token: appToken })
      }).catch(function () {});
    }
    setToken('');
    saveSession(null);
  }
  function authSession() { return session ? { email: session.email, expires_at: session.expires_at } : null; }

  var origSet = localStorage.setItem.bind(localStorage);
  var origRemove = localStorage.removeItem.bind(localStorage);
  var hydrating = false;
  var queue = Promise.resolve();
  var errCb = null;
  var cursors = {};   // tabla / app_kv -> mayor updated_at ya visto (cursor del sondeo incremental)
  var rpcMissing = {}; // funciones de lectura que aún no existen en la base

  // ISO 8601 compara lexicográficamente: devuelve el timestamp más reciente de dos.
  function maxUpdated(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  function flagError(e) {
    console.error('[FNSync] Error al sincronizar:', e);
    if (typeof errCb === 'function') { try { errCb(e); } catch (_) {} }
  }
  function enqueue(fn) {
    queue = queue.then(fn).catch(flagError);
    return queue;
  }

  // Lee las filas de una colección: por tabla o, si está definido, por función RPC
  // (así la tabla puede quedar sin permiso de lectura pública).
  async function fetchRows(cfg, since) {
    // Camino normal (base blindada): función con token de sesión.
    if (!gateMissing) {
      if (!hasSession()) { await probeGate(); }
      if (!gateMissing && !hasSession()) return [];
      if (!gateMissing) try {
        var g = await gate('fn_pull', { p_token: appToken, p_table: cfg.table, p_since: since || null });
        return Array.isArray(g) ? g : [];
      } catch (e) { if (!e.missing) throw e; }
    }
    if (cfg.readRpc && !rpcMissing[cfg.readRpc]) {
      var res = await fetch(SUPABASE_URL + 'rpc/' + cfg.readRpc, {
        method: 'POST', headers: baseHeaders(), body: '{}'
      });
      if (res.ok) {
        var all = await res.json();
        if (!Array.isArray(all)) all = [];
        if (since) all = all.filter(function (r) { return !r.updated_at || r.updated_at >= since; });
        return all;
      }
      var txt = await res.text();
      // Si la función todavía no está instalada en la base, se lee la tabla
      // como antes (para no dejar la app inservible mientras se aplica el SQL).
      if (res.status === 404 || /PGRST202|does not exist/i.test(txt)) {
        rpcMissing[cfg.readRpc] = true;
        console.warn('[FNSync] ' + cfg.readRpc + ' no está instalada; leyendo la tabla ' + cfg.table + '.');
      } else {
        throw new Error('RPC ' + cfg.readRpc + ' → ' + res.status + ' ' + txt);
      }
    }
    var url = SUPABASE_URL + cfg.table + '?select=id,data,updated_at';
    if (since) url += '&updated_at=gte.' + encodeURIComponent(since);
    url += '&order=updated_at.asc&limit=100000';
    var r2 = await fetch(url, { headers: baseHeaders() });
    if (!r2.ok) throw new Error('GET ' + cfg.table + ' → ' + r2.status + ' ' + (await r2.text()));
    var direct = await r2.json();
    if (!Array.isArray(direct)) direct = [];
    // La tabla puede estar protegida (RLS) y devolver 0 filas sin error. Si hay una
    // función de lectura declarada, se reintenta por ahí antes de dar la lista por vacía:
    // es lo que evita la pantalla "No se cargaron los usuarios desde la nube".
    if (!direct.length && cfg.readRpc) {
      var rr = await fetch(SUPABASE_URL + 'rpc/' + cfg.readRpc, {
        method: 'POST', headers: baseHeaders(), body: '{}'
      });
      if (rr.ok) {
        var viaRpc = await rr.json();
        if (Array.isArray(viaRpc) && viaRpc.length) {
          rpcMissing[cfg.readRpc] = false;
          if (since) viaRpc = viaRpc.filter(function (r) { return !r.updated_at || r.updated_at >= since; });
          return viaRpc;
        }
      }
    }
    return direct;
  }

  // Lee app_kv por la puerta (o directo, si el blindaje aún no está instalado).
  async function fetchKv(since) {
    if (!gateMissing) {
      if (!hasSession()) { await probeGate(); }
      if (!gateMissing && !hasSession()) return [];
      if (!gateMissing) try {
        var g = await gate('fn_kv_pull', { p_token: appToken, p_since: since || null });
        return Array.isArray(g) ? g : [];
      } catch (e) { if (!e.missing) throw e; }
    }
    var url = SUPABASE_URL + 'app_kv?select=key,value,updated_at';
    if (since) url += '&updated_at=gte.' + encodeURIComponent(since);
    url += '&order=updated_at.asc&limit=100000';
    var res = await fetch(url, { headers: baseHeaders() });
    if (!res.ok) throw new Error('GET app_kv → ' + res.status + ' ' + (await res.text()));
    return await res.json();
  }

  // ---------------- Hidratación (nube -> local) ----------------
  // Hidrata UNA colección: baja todas sus filas y refresca su copia local.
  async function hydrateCollection(key, cfg, doRecovery) {
    var rows = await fetchRows(cfg, null);
    var cloudArr = rows.map(function (r) { return r.data; });
    rows.forEach(function (r) { cursors[cfg.table] = maxUpdated(r.updated_at, cursors[cfg.table]); });
    var cloudIds = {};
    cloudArr.forEach(function (it) { cloudIds[rowIdOf(it, cfg)] = true; });

    var localArr = [];
    try { localArr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { localArr = []; }
    if (!Array.isArray(localArr)) localArr = [];

    // Registros que están en este dispositivo pero NO en la nube.
    var localOnly = localArr.filter(function (it) {
      var id = rowIdOf(it, cfg);
      return id && id !== 'undefined' && id !== 'null' && !cloudIds[id];
    });

    if (doRecovery && localOnly.length > 0) {
      // Se suben (merge) y se conservan junto con lo de la nube. Nada se pierde.
      var now = new Date().toISOString();
      await upsertRows(cfg.table, localOnly.map(function (it) {
        return { id: rowIdOf(it, cfg), data: it, updated_at: now };
      }));
      origSet(key, JSON.stringify(cloudArr.concat(localOnly)));
      cursors[cfg.table] = maxUpdated(now, cursors[cfg.table]);
    } else if (cloudArr.length > 0) {
      origSet(key, JSON.stringify(cloudArr));
    } else {
      localStorage.removeItem(key);
    }
  }

  // Hidrata SOLO las colecciones indicadas (informe público por QR: no hace falta
  // descargar usuarios, ventas ni cotizaciones para mostrar un informe).
  async function hydrateOnly(keys) {
    hydrating = true;
    try {
      await Promise.allSettled((keys || []).map(function (k) {
        if (!COLLECTIONS[k]) return Promise.resolve();
        return hydrateCollection(k, COLLECTIONS[k], false);
      }));
    } finally {
      hydrating = false;
    }
  }

  async function hydrate() {
    await refreshSession();
    if (!hasSession()) await probeGate();
    if (!gateMissing && !hasSession()) {
      var e0 = new Error('Debe iniciar sesión para ver los datos.');
      e0.sessionRequired = true;
      throw e0;
    }
    hydrating = true;
    try {
      var res, rows;
      // Recuperación por única vez por dispositivo: la PRIMERA hidratación sube a la
      // nube las inspecciones/registros que solo existen en este teléfono (creados
      // antes de que la nube funcionara), sin borrar nada. Después de eso, manda la nube.
      var RECOVERY_FLAG = 'fullneumaticos_localup_v1';
      var doRecovery = !localStorage.getItem(RECOVERY_FLAG);

      // Todas las colecciones en paralelo. Si UNA falla (permisos, tabla nueva),
      // se conserva la copia local y la app arranca igual: solo se avisa. Antes,
      // cualquier fallo dejaba la app inservible con "No se pudo conectar".
      var results = await Promise.allSettled(Object.keys(COLLECTIONS).map(function (key) {
        return hydrateCollection(key, COLLECTIONS[key], doRecovery);
      }));
      var failed = results.filter(function (r) { return r.status === 'rejected'; });
      if (failed.length === results.length) {
        throw failed[0].reason || new Error('No se pudo leer ninguna tabla');
      }
      if (failed.length) {
        failed.forEach(function (f) { flagError(f.reason); });
      }

      rows = await fetchKv(null);
      var map = {};
      rows.forEach(function (r) { map[r.key] = r.value; cursors['app_kv'] = maxUpdated(r.updated_at, cursors['app_kv']); });
      for (var lk in KV) {
        if (Object.prototype.hasOwnProperty.call(map, KV[lk])) {
          origSet(lk, JSON.stringify(map[KV[lk]]));
        } else {
          // Igual que con las colecciones: si hay valor local y la nube no lo tiene, se sube.
          var localVal = localStorage.getItem(lk);
          if (localVal != null) {
            try { await kvUpsert(KV[lk], JSON.parse(localVal)); } catch (e) { localStorage.removeItem(lk); }
          } else {
            localStorage.removeItem(lk);
          }
        }
      }

      // Recuperación completada: no volver a hacer el merge-up en este dispositivo.
      origSet('fullneumaticos_localup_v1', '1');
    } finally {
      hydrating = false;
    }
  }

  // ---------------- Empuje (local -> nube) ----------------
  // Tablas cuya escritura pasa por función (así la tabla puede quedar cerrada:
  // la app no necesita permisos directos y no puede leer las contraseñas).
  var WRITE_RPC = {
    users: { upsert: 'fn_users_upsert', del: 'fn_users_delete' }
  };

  async function callRpc(name, body) {
    var res = await fetch(SUPABASE_URL + 'rpc/' + name, {
      method: 'POST', headers: baseHeaders(), body: JSON.stringify(body)
    });
    if (!res.ok) {
      var txt = await res.text();
      var e = new Error('RPC ' + name + ' → ' + res.status + ' ' + txt.slice(0, 200));
      e.missing = res.status === 404 || /PGRST202|does not exist/i.test(txt);
      throw e;
    }
    return await res.json().catch(function () { return null; });
  }

  async function upsertRows(table, rows) {
    if (!rows.length) return;
    if (!gateMissing) {
      if (!hasSession()) return;
      try { await gate('fn_push', { p_token: appToken, p_table: table, p_rows: rows }); return; }
      catch (e) { if (!e.missing) throw e; }
    }
    var rpc = WRITE_RPC[table];
    if (rpc && !rpcMissing[rpc.upsert]) {
      try { await callRpc(rpc.upsert, { p_rows: rows }); return; }
      catch (e) { if (!e.missing) throw e; rpcMissing[rpc.upsert] = true; }
    }
    var res = await fetch(SUPABASE_URL + table, {
      method: 'POST',
      headers: withPrefer('resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(rows)
    });
    if (!res.ok) throw new Error('UPSERT ' + table + ' → ' + res.status + ' ' + (await res.text()));
  }
  async function deleteIds(table, ids) {
    if (!ids.length) return;
    if (!gateMissing) {
      if (!hasSession()) return;
      try { await gate('fn_remove', { p_token: appToken, p_table: table, p_ids: ids }); return; }
      catch (e) { if (!e.missing) throw e; }
    }
    var rpc = WRITE_RPC[table];
    if (rpc && !rpcMissing[rpc.del]) {
      try { await callRpc(rpc.del, { p_ids: ids }); return; }
      catch (e) { if (!e.missing) throw e; rpcMissing[rpc.del] = true; }
    }
    var inList = ids.map(function (id) { return '"' + String(id).replace(/"/g, '') + '"'; }).join(',');
    var res = await fetch(SUPABASE_URL + table + '?id=in.(' + encodeURIComponent(inList) + ')', {
      method: 'DELETE',
      headers: withPrefer('return=minimal')
    });
    if (!res.ok) throw new Error('DELETE ' + table + ' → ' + res.status + ' ' + (await res.text()));
  }
  async function kvUpsert(kvKey, value) {
    if (!gateMissing) {
      if (!hasSession()) return;
      try { await gate('fn_kv_push', { p_token: appToken, p_key: kvKey, p_value: value }); return; }
      catch (e) { if (!e.missing) throw e; }
    }
    var res = await fetch(SUPABASE_URL + 'app_kv', {
      method: 'POST',
      headers: withPrefer('resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify({ key: kvKey, value: value, updated_at: new Date().toISOString() })
    });
    if (!res.ok) throw new Error('UPSERT app_kv ' + kvKey + ' → ' + res.status + ' ' + (await res.text()));
  }

  function rowIdOf(item, cfg) {
    var id = item[cfg.idField];
    if (cfg.idField === 'licensePlate' && id != null) id = String(id).toUpperCase();
    return String(id);
  }

  // ---------------- Intercepta escrituras locales ----------------
  localStorage.setItem = function (key, value) {
    var prev = (!hydrating && (COLLECTIONS[key] || KV[key])) ? localStorage.getItem(key) : null;
    origSet(key, value);
    if (hydrating) return;

    if (COLLECTIONS[key]) {
      var cfg = COLLECTIONS[key];
      enqueue(function () {
        var arr;
        try { arr = JSON.parse(value) || []; } catch (e) { return; }

        // Mapa del estado anterior (por id -> JSON del registro) para detectar
        // qué cambió realmente. Así subimos SOLO los registros nuevos o modificados
        // (no toda la colección), evitando pisar/resucitar datos de otros dispositivos.
        var prevById = {};
        if (prev) {
          try {
            JSON.parse(prev).forEach(function (item) {
              prevById[rowIdOf(item, cfg)] = JSON.stringify(item);
            });
          } catch (e) {}
        }

        var now = new Date().toISOString();
        var present = {};
        var changed = [];
        arr.forEach(function (item) {
          var id = rowIdOf(item, cfg);
          if (!id || id === 'undefined' || id === 'null') return;
          present[id] = true;
          var json = JSON.stringify(item);
          if (prevById[id] !== json) {
            // registro nuevo o modificado
            changed.push({ id: id, data: item, updated_at: now });
          }
        });

        // Solo se borran los registros que estaban antes y ya no están: una
        // eliminación explícita hecha en ESTE dispositivo.
        var delIds = [];
        Object.keys(prevById).forEach(function (id) {
          if (!present[id]) delIds.push(id);
        });

        return upsertRows(cfg.table, changed).then(function () { return deleteIds(cfg.table, delIds); });
      });
    } else if (KV[key]) {
      var kvk = KV[key];
      enqueue(function () {
        var val;
        try { val = JSON.parse(value); } catch (e) { return; }
        return kvUpsert(kvk, val);
      });
    }
  };

  // Algunas operaciones podrían vaciar una colección con removeItem.
  localStorage.removeItem = function (key) {
    var prev = (!hydrating && COLLECTIONS[key]) ? localStorage.getItem(key) : null;
    origRemove(key);
    if (hydrating) return;
    if (COLLECTIONS[key] && prev) {
      var cfg = COLLECTIONS[key];
      enqueue(function () {
        var delIds = [];
        try {
          JSON.parse(prev).forEach(function (item) { delIds.push(rowIdOf(item, cfg)); });
        } catch (e) {}
        return deleteIds(cfg.table, delIds);
      });
    }
  };

  // ---------------- Supabase Storage (fotos) ----------------
  // Origen del proyecto a partir de la URL REST.
  var ORIGIN = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '/');
  var STORAGE_OBJECT = ORIGIN + 'storage/v1/object/';
  var PHOTO_BUCKET = 'inspection-photos';

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = (parts[0].match(/:(.*?);/) || [, 'image/jpeg'])[1];
    var bin = atob(parts[1]);
    var len = bin.length;
    var arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Reescala a un máximo de lado y recomprime como JPEG para que las fotos
  // no pesen de más (las cámaras producen imágenes de varios MB).
  function compressDataUrl(dataUrl, maxDim, quality) {
    return new Promise(function (resolve) {
      try {
        var im = new Image();
        im.onload = function () {
          var w = im.naturalWidth, h = im.naturalHeight;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          c.getContext('2d').drawImage(im, 0, 0, cw, ch);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        im.onerror = function () { resolve(dataUrl); };
        im.src = dataUrl;
      } catch (e) { resolve(dataUrl); }
    });
  }

  // Sube una foto (data URL) a Storage y devuelve su URL pública.
  // Reintenta con espera creciente: en móvil la primera petición se cae seguido
  // aunque haya señal (cambio de antena, red saturada, wifi que no navega).
  async function uploadPhoto(path, dataUrl, attempts) {
    var compressed = await compressDataUrl(dataUrl, 1280, 0.7);
    var blob = dataUrlToBlob(compressed);
    var safePath = path.split('/').map(encodeURIComponent).join('/');
    var tries = attempts || 3;
    var lastErr = null;
    for (var i = 0; i < tries; i++) {
      if (i > 0) await new Promise(function (r) { setTimeout(r, 800 * Math.pow(2, i - 1)); });
      try {
        var res = await fetch(STORAGE_OBJECT + PHOTO_BUCKET + '/' + safePath, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': blob.type,
            'x-upsert': 'true'
          },
          body: blob
        });
        if (res.ok) return STORAGE_OBJECT + 'public/' + PHOTO_BUCKET + '/' + safePath;
        var body = await res.text();
        // Errores de configuración: no sirve reintentar, hay que arreglar Supabase.
        if (/Bucket not found/i.test(body)) throw new Error('CONFIG: falta el bucket "' + PHOTO_BUCKET + '" en Supabase Storage.');
        if (res.status === 403 || /new row violates|not authorized|Unauthorized/i.test(body)) {
          throw new Error('CONFIG: el bucket "' + PHOTO_BUCKET + '" no permite subir (falta política de INSERT).');
        }
        lastErr = new Error('UPLOAD ' + res.status + ' ' + body.slice(0, 200));
      } catch (e) {
        if (/^CONFIG:/.test(e.message || '')) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('UPLOAD falló');
  }

  // ---------------- Cola de fotos pendientes (IndexedDB) ----------------
  // Las fotos que no se pudieron subir NO se pierden: quedan guardadas aquí
  // (IndexedDB, no localStorage, para no llenar la cuota y romper la app) y se
  // reintentan solas al abrir la app, al recuperar conexión y cada minuto.
  var IDB_NAME = 'fn-photos', IDB_STORE = 'pending', idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'pk' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return idbP;
  }
  function idbReq(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, mode);
        var out = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  async function queuePhoto(inspId, key, dataUrl) {
    try {
      var small = await compressDataUrl(dataUrl, 1280, 0.7);
      await idbReq('readwrite', function (st) {
        return st.put({ pk: inspId + '|' + key, inspId: inspId, key: key, dataUrl: small, at: Date.now() });
      });
    } catch (e) { flagError(e); }
  }
  async function pendingPhotos() {
    try { return (await idbReq('readonly', function (st) { return st.getAll(); })) || []; } catch (e) { return []; }
  }
  async function pendingPhotoCount() { return (await pendingPhotos()).length; }

  // Escribe la URL de la foto en la inspección local (y por el interceptor, en la nube).
  var INSP_KEY = 'fullneumaticos_inspections';
  function patchInspectionPhoto(inspId, key, url) {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(INSP_KEY) || '[]'); } catch (e) { return false; }
    if (!Array.isArray(arr)) return false;
    var hit = false;
    arr.forEach(function (it) {
      if (it && it.id === inspId) { it.photos = it.photos || {}; it.photos[key] = url; hit = true; }
    });
    if (hit) localStorage.setItem(INSP_KEY, JSON.stringify(arr));
    return hit;
  }

  var retrying = false;
  async function retryPendingPhotos() {
    if (retrying) return { ok: 0, left: 0 };
    if (navigator.onLine === false) return { ok: 0, left: await pendingPhotoCount() };
    retrying = true;
    var ok = 0, left = 0, configErr = null;
    try {
      var items = await pendingPhotos();
      // De 3 en 3: en móvil muchas subidas a la vez se atascan y fallan todas.
      for (var i = 0; i < items.length; i += 3) {
        var chunk = items.slice(i, i + 3);
        var results = await Promise.all(chunk.map(async function (it) {
          try {
            var url = await uploadPhoto(it.inspId + '/' + it.key + '.jpg', it.dataUrl, 2);
            patchInspectionPhoto(it.inspId, it.key, url);
            await idbReq('readwrite', function (st) { return st.delete(it.pk); });
            return 'ok';
          } catch (e) {
            if (/^CONFIG:/.test(e.message || '')) { configErr = e.message; return 'config'; }
            return 'fail';
          }
        }));
        results.forEach(function (r) { if (r === 'ok') ok++; else left++; });
        if (configErr) { left += items.length - (i + chunk.length); break; }
      }
    } finally {
      retrying = false;
    }
    if (ok > 0) { try { window.dispatchEvent(new Event('fnsync:updated')); } catch (_) {} }
    try { window.dispatchEvent(new CustomEvent('fnsync:photos', { detail: { ok: ok, left: left, configError: configErr } })); } catch (_) {}
    return { ok: ok, left: left, configError: configErr };
  }

  function startPhotoRetry() {
    var run = function () { pendingPhotoCount().then(function (n) { if (n > 0) retryPendingPhotos(); }); };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') run(); });
    setInterval(function () { if (document.visibilityState === 'visible') run(); }, 60000);
    setTimeout(run, 4000);
  }

  // ---------------- Sondeo incremental (nube -> local, en vivo) ----------------
  // Cada cierto tiempo trae SOLO las filas con updated_at más nuevo que lo ya visto
  // y las fusiona en la copia local. Detecta altas y ediciones (no borrados).
  var polling = false;
  var autoStarted = false;

  async function pollCollection(key, cfg) {
    var since = cursors[cfg.table];
    var rows = await fetchRows(cfg, since);
    if (!rows.length) return false;

    var localArr = [];
    try { localArr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { localArr = []; }
    if (!Array.isArray(localArr)) localArr = [];
    var byId = {}, order = [];
    localArr.forEach(function (it) { var id = rowIdOf(it, cfg); byId[id] = it; order.push(id); });

    var changed = false;
    rows.forEach(function (r) {
      cursors[cfg.table] = maxUpdated(r.updated_at, cursors[cfg.table]);
      var id = rowIdOf(r.data, cfg);
      if (!id || id === 'undefined' || id === 'null') return;
      var incoming = JSON.stringify(r.data);
      if (!(id in byId)) { byId[id] = r.data; order.push(id); changed = true; }
      else if (JSON.stringify(byId[id]) !== incoming) { byId[id] = r.data; changed = true; }
    });
    if (changed) origSet(key, JSON.stringify(order.map(function (id) { return byId[id]; })));
    return changed;
  }

  async function pollKv() {
    var since = cursors['app_kv'];
    var rows = await fetchKv(since);
    if (!rows.length) return false;
    var revKV = {};
    for (var lk in KV) revKV[KV[lk]] = lk;
    var changed = false;
    rows.forEach(function (r) {
      cursors['app_kv'] = maxUpdated(r.updated_at, cursors['app_kv']);
      var localKey = revKV[r.key];
      if (!localKey) return;
      var incoming = JSON.stringify(r.value);
      if (localStorage.getItem(localKey) !== incoming) { origSet(localKey, incoming); changed = true; }
    });
    return changed;
  }

  async function poll() {
    if (polling || hydrating) return false;
    await refreshSession();
    polling = true;
    var any = false;
    try {
      var tasks = Object.keys(COLLECTIONS).map(function (key) {
        return pollCollection(key, COLLECTIONS[key]).catch(function (e) { flagError(e); return false; });
      });
      tasks.push(pollKv().catch(function (e) { flagError(e); return false; }));
      var results = await Promise.all(tasks);
      any = results.some(Boolean);
    } finally {
      polling = false;
    }
    // Avisa a la app para que vuelva a leer y se repinte sin recargar.
    if (any) { try { window.dispatchEvent(new Event('fnsync:updated')); } catch (_) {} }
    return any;
  }

  // Arranca el sondeo periódico. Solo sondea con la pestaña visible (no gasta datos
  // en segundo plano) y refresca de inmediato al volver a la app.
  function startAutoSync(intervalMs) {
    if (autoStarted) return;
    autoStarted = true;
    var ms = intervalMs || 10000;
    setInterval(function () { if (document.visibilityState === 'visible') poll(); }, ms);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll();
    });
    window.addEventListener('focus', function () { poll(); });
  }

  // Informe público por QR: baja SOLO esa inspección y su vehículo por una
  // función dedicada. Ninguna otra tabla queda expuesta sin sesión.
  async function hydrateReport(inspId) {
    if (!inspId) return false;
    try {
      var r = await gate('fn_report_public', { p_id: String(inspId) });
      if (!r || !r.inspection) return false;
      hydrating = true;
      try {
        origSet('fullneumaticos_inspections', JSON.stringify([r.inspection]));
        if (r.vehicle) origSet('fullneumaticos_vehicles', JSON.stringify([r.vehicle]));
      } finally { hydrating = false; }
      return true;
    } catch (e) {
      if (e.missing) return await hydrateOnly(['fullneumaticos_inspections', 'fullneumaticos_vehicles']);
      throw e;
    }
  }

  window.FNSync = {
    hydrate: hydrate,
    hydrateOnly: hydrateOnly,
    hydrateReport: hydrateReport,
    hasSession: hasSession,
    checkGate: function () { return probeGate(); },
    setToken: setToken,
    uploadPhoto: uploadPhoto,
    queuePhoto: queuePhoto,
    pendingPhotoCount: pendingPhotoCount,
    retryPendingPhotos: retryPendingPhotos,
    startPhotoRetry: startPhotoRetry,
    poll: poll,
    startAutoSync: startAutoSync,
    onError: function (cb) { errCb = cb; },
    // Borra del dispositivo todo lo sincronizado (al cerrar sesión).
    purgeLocal: function () {
      try {
        Object.keys(COLLECTIONS).forEach(function (k) { origRemove(k); });
        Object.keys(KV).forEach(function (k) { origRemove(k); });
        cursors = {};
        setToken('');
      } catch (e) {}
    },
    authSignIn: authSignIn,
    authSignOut: authSignOut,
    authSession: authSession,
    // Valida el ingreso EN EL SERVIDOR: la app manda usuario y contraseña y recibe
    // solo el perfil (sin contraseña). Así no viaja ninguna clave al navegador.
    login: async function (identifier, password) {
      var res = await fetch(SUPABASE_URL + 'rpc/fn_login', {
        method: 'POST', headers: baseHeaders(),
        body: JSON.stringify({ p_identifier: identifier, p_password: password })
      });
      if (!res.ok) throw new Error('LOGIN ' + res.status + ' ' + (await res.text()).slice(0, 160));
      var out = await res.json();
      // Token de sesión: es la llave con la que la base entrega datos.
      if (out && out.ok && out.token) { sessionLost = false; setToken(out.token); }
      return out;
    },
    // ¿Llego de verdad esta fila a la nube? (para confirmar altas críticas como usuarios)
    verifyRow: async function (table, id) {
      try {
        await queue; // espera a que se vacíe la cola de escrituras pendientes
        var cfg = null;
        for (var k in COLLECTIONS) { if (COLLECTIONS[k].table === table) cfg = COLLECTIONS[k]; }
        if (cfg && cfg.readRpc && !rpcMissing[cfg.readRpc]) {
          var rows0 = await fetchRows(cfg, null);
          return { ok: rows0.some(function (r) { return String(r.id) === String(id); }) };
        }
        var res = await fetch(SUPABASE_URL + table + '?id=eq.' + encodeURIComponent(id) + '&select=id', { headers: baseHeaders() });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160) };
        var rows = await res.json();
        return { ok: Array.isArray(rows) && rows.length > 0 };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    flush: function () { return queue; }
  };
})();
