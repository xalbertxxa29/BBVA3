// menu.js — Dashboard + FAB + Mapa + Toast + GPS robusto (WebView-friendly)
(() => {
  // ===== Atajos / Firebase =====
  const $  = (s) => document.querySelector(s);
  const auth = window.auth;
  const db   = window.db;

  // Cache offline de Firestore (ignorar errores si ya estaba)
  try {
    firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(() => {});
  } catch {}

  // ===== Utilidades UI =====
  function toast(msg, type = 'info') { // info | ok | warn | danger | err
    const t = $('#toast'); if (!t) return;
    t.textContent = msg;
    t.className = `toast show ${type === 'err' ? 'danger' : type}`;
    setTimeout(() => t.classList.remove('show'), 3000);
  }
  function showOverlay(msg = 'Cargando…', sub = '') {
    const ov = $('#overlay'); if (!ov) return;
    $('#overlay-msg').textContent = msg;
    $('#overlay-sub').textContent = sub || '';
    $('#overlay-progress').style.width = '0%';
    ov.classList.add('active'); ov.setAttribute('aria-hidden', 'false');
  }
  function setProgress(f) {
    const p = $('#overlay-progress');
    if (p) p.style.width = `${Math.min(100, Math.round((f || 0) * 100))}%`;
  }
  function hideOverlay() {
    const ov = $('#overlay'); if (!ov) return;
    ov.classList.remove('active'); ov.setAttribute('aria-hidden', 'true');
  }

  // ===== Tabs =====
  function wireTabs() {
    const btns = document.querySelectorAll('.tab-btn');
    btns.forEach((b) => {
      b.addEventListener('click', () => {
        btns.forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const id = b.dataset.tab;
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
        $('#tab-' + id)?.classList.add('active');
      });
    });
  }

  // ===== Fecha y mes en UI =====
  function setToday() {
    const el = $('#today'); if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleDateString('es-PE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  function setMonthLabel() {
    const el = $('#mes-actual'); if (!el) return;
    const now = new Date();
    el.textContent = `Mes: ${now.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}`;
  }

  // ===== Mapa + GPS robusto =====
  let map, meMarker, watchId = null;
  const DEFAULT_CENTER = { lat: -12.05, lng: -77.05 }; // Lima

  function placeMe(pos) {
    if (!pos || !map) return;
    if (!meMarker) {
      meMarker = new google.maps.Marker({
        map,
        position: pos,
        title: 'Tu ubicación',
        // HTTPS para evitar mixed-content
        icon: 'https://maps.gstatic.com/mapfiles/ms2/micons/blue-dot.png'
      });
    } else {
      meMarker.setPosition(pos);
    }
    map.setCenter(pos);
  }

  function tryOneShot(highAccuracy = true, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('No geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p)  => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        (e)  => reject(e),
        { enableHighAccuracy: highAccuracy, maximumAge: 0, timeout }
      );
    });
  }

  async function startGPS() {
    try {
      const pos = await tryOneShot(true, 8000);
      placeMe(pos);
    } catch {
      try {
        const pos = await tryOneShot(false, 8000);
        placeMe(pos);
      } catch {
        toast('No pudimos obtener tu ubicación. Puedes continuar.', 'warn');
        placeMe(DEFAULT_CENTER);
      }
    }

    if ('geolocation' in navigator) {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = navigator.geolocation.watchPosition(
        (p) => placeMe({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
      );
    }
  }

  // callback para el script de Google Maps
  function initMap() {
    try {
      const host = $('#map') || document.body;
      map = new google.maps.Map(host, { center: DEFAULT_CENTER, zoom: 13 });
      setTimeout(() => google.maps.event.trigger(map, 'resize'), 100);

      // Arranca GPS con la primera interacción (mejor permisos en móvil/WebView)
      document.addEventListener('pointerdown', function once() {
        startGPS().catch(() => {});
        document.removeEventListener('pointerdown', once);
      }, { once: true });

      // Reajusta centro al rotar
      window.addEventListener('resize', () => {
        try { google.maps.event.trigger(map, 'resize'); } catch {}
      });
    } catch {}
  }
  window.initMap = initMap;

  // ===== Helpers de datos =====
  const norm   = (s) => (s || '').toString().trim().toUpperCase();
  const clamp0 = (n) => Math.max(0, Number(n || 0));
  function monthRange(d = new Date()) {
    const y = d.getFullYear(), m = d.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
  }

  // Parse flexible de createdAt (Timestamp | Date | number | string con mes en español)
  const MONTHS_ES = { enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,setiembre:8,octubre:9,noviembre:10,diciembre:11 };
  function parseDateFlexible(v) {
    try {
      if (!v) return null;
      if (typeof v?.toDate === 'function') return v.toDate();
      if (v instanceof Date) return v;
      if (typeof v === 'number') return new Date(v);
      if (typeof v === 'string') {
        const lower = v.toLowerCase();
        const m = lower.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
        if (m) {
          const day    = parseInt(m[1], 10);
          const monKey = m[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const mon    = MONTHS_ES[monKey];
          const year   = parseInt(m[3], 10);
          if (mon != null) return new Date(year, mon, day);
        }
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d;
      }
    } catch {}
    return null;
  }
  function isInCurrentMonth(dt) {
    if (!dt) return false;
    const now = new Date();
    return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth();
  }

  // Normalizadores por tipo
  function pickOficina(r) {
    const data = r || {};
    return {
      id:      norm(data?.oficina?.id      || data?.id),
      turbina: norm(data?.oficina?.turbina || data?.turbina)
    };
  }
  function pickCajero(r) {
    const data = r || {};
    return {
      id:      norm(data?.cajero?.id || data?.id || data?.term_id),
      turbina: norm(data?.cajero?.turbina || data?.turbina)
    };
  }

  // Totales de locales por turbina (OFICINAS/CAJEROS) admitiendo nombres de campo distintos
  async function getTotalsByTurbina(t) {
    const T = norm(t);
    const empty = { docs: [] };

    const [of1, of2, cj1, cj2] = await Promise.all([
      db.collection('OFICINAS').where('turbina','==', T).get().catch(() => empty),
      db.collection('OFICINAS').where('TURBINA','==', T).get().catch(() => empty),
      db.collection('CAJEROS'). where('turbina','==', T).get().catch(() => empty),
      db.collection('CAJEROS'). where('TURBINA','==', T).get().catch(() => empty),
    ]);

    const ofSet = new Set([...of1.docs, ...of2.docs].map(d => d.id));
    const cjSet = new Set([...cj1.docs, ...cj2.docs].map(d => d.id));
    return { ofTotal: ofSet.size, cjTotal: cjSet.size };
  }

  // Únicos del mes en reportes (acepta turbina en raíz o anidado)
  async function getUniqueThisMonth(t) {
    const T = norm(t);
    const empty = { docs: [] };

    const [ofA, ofB, cjA, cjB] = await Promise.all([
      db.collection('reportes_oficinas').where('turbina','==', T).get().catch(() => empty),
      db.collection('reportes_oficinas').where('oficina.turbina','==', T).get().catch(() => empty),
      db.collection('reportes_cajeros') .where('turbina','==', T).get().catch(() => empty),
      db.collection('reportes_cajeros') .where('cajero.turbina','==', T).get().catch(() => empty),
    ]);

    // Unificar documentos sin duplicar
    const uniqById = (arr) => {
      const map = new Map();
      arr.forEach(d => { if (!map.has(d.id)) map.set(d.id, d); });
      return [...map.values()];
    };
    const ofDocs = uniqById([...(ofA.docs || []), ...(ofB.docs || [])]);
    const cjDocs = uniqById([...(cjA.docs || []), ...(cjB.docs || [])]);

    // Filtrar por mes actual
    const ofSet = new Set();
    ofDocs.forEach(d => {
      const data = d.data() || {};
      const when = parseDateFlexible(data.createdAt);
      if (isInCurrentMonth(when)) {
        const o = pickOficina(data);
        if (o.turbina === T && o.id) ofSet.add(o.id);
      }
    });

    const cjSet = new Set();
    cjDocs.forEach(d => {
      const data = d.data() || {};
      const when = parseDateFlexible(data.createdAt);
      if (isInCurrentMonth(when)) {
        const c = pickCajero(data);
        if (c.turbina === T && c.id) cjSet.add(c.id);
      }
    });

    return { ofUnique: ofSet.size, cjUnique: cjSet.size };
  }

  function setKPI(id, val) { const el = $('#'+id); if (el) el.textContent = String(val); }

  async function refreshKPIs() {
    const tur = $('#filtro-turbina')?.value || 'CONSOLA TORRE';
    $('#dash-loading')?.classList.add('show');
    setKPI('ofi-superv','…'); setKPI('ofi-pend','…'); setKPI('cj-superv','…'); setKPI('cj-pend','…');
    try {
      const [{ ofTotal, cjTotal }, { ofUnique, cjUnique }] =
        await Promise.all([ getTotalsByTurbina(tur), getUniqueThisMonth(tur) ]);
      setKPI('ofi-superv', ofUnique);
      setKPI('ofi-pend',  clamp0(ofTotal - ofUnique));
      setKPI('cj-superv', cjUnique);
      setKPI('cj-pend',  clamp0(cjTotal - cjUnique));
    } catch (e) {
      console.error(e);
      toast('No se pudieron calcular las métricas.', 'danger');
      ['ofi-superv','ofi-pend','cj-superv','cj-pend'].forEach(id => setKPI(id,'—'));
    } finally {
      $('#dash-loading')?.classList.remove('show');
    }
  }

  // ===== Tap confiable (evita doble disparo click+touch en WebView) =====
  function onReliableTap(el, handler) {
    if (!el) return;
    let last = 0;
    const fire = (e) => {
      e.preventDefault(); e.stopPropagation();
      const now = Date.now();
      if (now - last < 250) return; // descarta duplicados
      last = now;
      handler(e);
    };
    ['click','pointerup','touchend'].forEach(ev => el.addEventListener(ev, fire, { passive: false }));
    // Accesibilidad teclado
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e); }
    });
  }

  // ===== FAB + Modal (tres puntos) =====
  function wireFab() {
    const wrap  = $('#fab');
    const more  = $('#fab-more');
    const opts  = $('#fab-options');
    const plus  = $('#fab-plus');
    const modal = $('#new-overlay');

    const openFab  = () => { wrap?.classList.add('open');  more?.setAttribute('aria-expanded','true');  if (opts) { opts.classList.add('open');  opts.style.display='flex'; } };
    const closeFab = () => { wrap?.classList.remove('open'); more?.setAttribute('aria-expanded','false'); if (opts) { opts.classList.remove('open'); opts.style.display='none'; } };
    const toggle   = () => (wrap?.classList.contains('open') ? closeFab() : openFab());

    onReliableTap(more, toggle);

    // cerrar al tocar fuera
    document.addEventListener('click', (e) => {
      if (wrap?.classList.contains('open') && !wrap.contains(e.target)) closeFab();
    }, { passive: true });

    const openModal  = () => { modal?.classList.add('active'); modal?.setAttribute('aria-hidden','false'); };
    const closeModal = () => { modal?.classList.remove('active'); modal?.setAttribute('aria-hidden','true'); };

    onReliableTap(plus, () => { closeFab(); openModal(); });

    $('#new-cancel')?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (ev) => { if (ev.target === modal) closeModal(); });

    // Navegación de opciones
    document.querySelectorAll('.option-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.type;
        closeModal();
        if (t === 'ofi') location.href = 'formularioof.html';
        if (t === 'caj') location.href = 'formulariocaj.html';
      });
    });
  }

  // ===== Logout =====
  function wireLogout() {
    $('#logout-fab')?.addEventListener('click', async () => {
      try { await auth.signOut(); } catch {}
      location.href = 'index.html';
    });
  }

  // ===== Start =====
  document.addEventListener('DOMContentLoaded', () => {
    setToday(); setMonthLabel(); wireTabs(); wireFab(); wireLogout();

    auth?.onAuthStateChanged((u) => {
      if (!u) { location.href = 'index.html'; return; }
    });

    $('#filtro-turbina')?.addEventListener('change', refreshKPIs);
    refreshKPIs();

    // Si el usuario nunca toca la pantalla (desktop), pedimos GPS una vez
    setTimeout(() => { try { startGPS(); } catch {} }, 600);
  });
})();
