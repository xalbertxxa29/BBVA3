// formulariocaj.js — Cámara + subida diferida + cola offline + GPS fallback (CAJEROS)
(() => {
  // ===== Firebase singletons =====
  const a = window.auth;
  const d = window.db;
  const fbStorage = window.storage || firebase.storage();

  // Cache local Firestore (opcional)
  if (firebase && firebase.firestore && typeof firebase.firestore === 'function') {
    try { firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(()=>{}); } catch(e) {}
  }

  // ===== Utils DOM / UI =====
  const $ = s => document.querySelector(s);
  const normU = t => (t||'').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();

  // Encuentra el PRIMER elemento que exista entre varios ids
  const pick = (...ids) => { for (const id of ids) { const el = document.getElementById(id); if (el) return el; } return null; };
  const setVal = (val, ...ids) => { const el = pick(...ids); if (el) el.value = val ?? ''; };
  const getVal = (...ids) => { const el = pick(...ids); return el ? (el.value || '').trim() : ''; };

  // Toast centrado (reemplaza alert)
  function toast(msg, ms=2200){
    let shell = document.getElementById('app-toast');
    if (!shell){
      shell = document.createElement('div');
      shell.id = 'app-toast';
      shell.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999;';
      const card = document.createElement('div');
      card.id = 'app-toast-card';
      card.style.cssText = 'max-width:90%;background:#111c;color:#fff;padding:14px 16px;border-radius:12px;backdrop-filter:blur(3px);font-weight:600;text-align:center';
      shell.appendChild(card);
      document.body.appendChild(shell);
    }
    const card = document.getElementById('app-toast-card');
    card.textContent = msg;
    shell.style.display = 'flex';
    window.clearTimeout(shell._t);
    shell._t = setTimeout(()=>{ shell.style.display='none'; }, ms);
  }

  function showOverlay(msg='Cargando…', sub=''){
    const m = $('#overlay-msg'), s = $('#overlay-sub');
    if (m) m.textContent = msg;
    if (s) s.textContent = sub || '';
    setProgress(0);
    $('#overlay').classList.add('active');
  }
  function hideOverlay(){ $('#overlay').classList.remove('active'); }
  function setProgress(f){ const el = $('#overlay-progress'); if (el) el.style.width = `${Math.max(0, Math.min(100, Math.round((f||0)*100)))}%`; }

  // ===== Estado general =====
  let CAJEROS = [];
  let map, meMarker, atmMarker, geocoder, watchId = null;
  let lastUserPos = null;

  // ===== FOTOS (local hasta Enviar) =====
  let PHOTOS = [];
  function addPhotoBlob(blob){
    const preview = URL.createObjectURL(blob);
    PHOTOS.push({ blob, preview });
    renderPreviews();
  }
  function clearPhotos(){
    try{ PHOTOS.forEach(p => p.preview && URL.revokeObjectURL(p.preview)); }catch{}
    PHOTOS = [];
    renderPreviews();
  }
  function renderPreviews(){
    const wrap = $('#foto-preview'); if (!wrap) return;
    wrap.innerHTML = '';
    PHOTOS.forEach((p, idx)=>{
      const box = document.createElement('div');
      box.className = 'thumb';
      box.innerHTML = `<button class="del" title="Eliminar">&times;</button>`;
      const img = new Image(); img.src = p.preview; box.appendChild(img);
      box.querySelector('.del').addEventListener('click', ()=>{
        try{ URL.revokeObjectURL(PHOTOS[idx].preview); }catch{}
        PHOTOS.splice(idx,1); renderPreviews();
      });
      wrap.appendChild(box);
    });
  }

  // ===== Cámara integrada =====
  let camStream = null;
  let camFacing = 'environment';
  const camEls = {};
  function camGrabEls(){
    camEls.wrap = $('#cam-overlay');
    camEls.video= $('#cam-video');
    camEls.hint = $('#cam-hint');
    camEls.close= $('#cam-close');
    camEls.flip = $('#cam-flip');
    camEls.shoot= $('#cam-shoot');
    camEls.fallbackWrap = $('#cam-fallback');
    camEls.fileBtn = $('#cam-file-btn');
    camEls.filePick= $('#cam-file');
  }
  async function camStart(){
    if (camStream) camStream.getTracks().forEach(t=>t.stop());
    try{
      camStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal: camFacing } }, audio:false });
      camEls.video.srcObject = camStream;
      await camEls.video.play();
      camEls.video.style.transform = (camFacing==='user') ? 'scaleX(-1)' : 'none';
      camEls.fallbackWrap.hidden = true;
    }catch(err){
      console.warn('getUserMedia falló -> fallback', err);
      camEls.fallbackWrap.hidden = false;
      camEls.hint.textContent = 'Si tu WebView bloquea la cámara, usa “Cámara nativa”.';
    }
  }
  function camOpen(){ camEls.wrap.classList.add('active'); camEls.wrap.setAttribute('aria-hidden','false'); camStart(); }
  function camClose(){ if (camStream) camStream.getTracks().forEach(t=>t.stop()); camEls.wrap.classList.remove('active'); camEls.wrap.setAttribute('aria-hidden','true'); }
  function camCaptureBlob(){
    const canvas = document.createElement('canvas');
    canvas.width  = camEls.video.videoWidth || 1280;
    canvas.height = camEls.video.videoHeight|| 720;
    const ctx = canvas.getContext('2d');
    if (camFacing==='user'){ ctx.translate(canvas.width,0); ctx.scale(-1,1); }
    ctx.drawImage(camEls.video, 0, 0, canvas.width, canvas.height);
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
  }
  async function camFromCamera(){
    try{
      const b = await camCaptureBlob();
      addPhotoBlob(b); // solo local
      camClose();
    }catch(e){ toast('No se pudo capturar la foto.'); console.error(e); }
  }
  function camFromFiles(files){
    const arr = Array.from(files||[]);
    if (!arr.length) return;
    arr.forEach(f => addPhotoBlob(f)); // local
    camClose();
  }

  // ===== IndexedDB (cola offline) =====
  const IDB_NAME = 'cj-reports-db';
  const IDB_STORE = 'queue';
  function openIDB(){
    return new Promise((resolve, reject)=>{
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)){
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(item){
    const db = await openIDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(IDB_STORE).put(item);
    });
  }
  async function idbGetAll(){
    const db = await openIDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDel(key){
    const db = await openIDB();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(IDB_STORE).delete(key);
    });
  }

  // Blobs serializables
  async function blobToStorable(b){
    const buf = await b.arrayBuffer();
    return { type: b.type || 'image/jpeg', data: buf };
  }
  function storableToBlob(o){
    return new Blob([o.data], { type: o.type || 'image/jpeg' });
  }

  // Reintento automático al reconectar
  window.addEventListener('online', ()=> { processQueue().catch(console.error); });
  async function processQueue(){
    const items = await idbGetAll();
    if (!items.length) return;
    const user = a.currentUser || await new Promise(res => { const unsub = a.onAuthStateChanged(u=>{ unsub(); res(u); }); });
    if (!user) return;

    showOverlay('Reintentando envíos pendientes…', `Pendientes: ${items.length}`);
    let done = 0;
    for (const it of items){
      try {
        // Subir fotos del item
        const urls = [];
        for (let i=0;i<it.photos.length;i++){
          const b = storableToBlob(it.photos[i]);
          const ref = fbStorage.ref(`capturas/${user.uid}/${it.id}-${i}.jpg`);
          await ref.put(b, { contentType: b.type });
          urls.push(await ref.getDownloadURL());
        }
        // Guardar doc
        const payload = { ...it.payload, fotos: urls, user: { uid: user.uid, email: user.email || null } };
        await d.collection('reportes_cajeros').add(payload);
        await idbDel(it.id);
        done++;
        setProgress(done/items.length);
        const sub = $('#overlay-sub'); if (sub) sub.textContent = `Enviados: ${done}/${items.length}`;
      } catch (e) {
        console.warn('Reintento falló:', e);
      }
    }
    hideOverlay();
  }

  // ===== Inicio =====
  document.addEventListener('DOMContentLoaded', async () => {
    const fechaEl = document.getElementById('fecha');
    if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString();

    await new Promise(res => a.onAuthStateChanged(u => { if(!u) location.href='index.html'; else res(); }));

    // Si la API de Maps ya está cargada y no se inicializó, inicialízala
    if (window.google && google.maps && !map) { initMapOfi(); }

    showOverlay('Cargando cajeros…','Leyendo colección CAJEROS');
    await loadCajeros(); hideOverlay();

    wireSearch(); camGrabEls(); wireCamera(); wireActions();

    showOverlay('Cargando categorías…','Leyendo colección NOMENCLATURA');
    await loadCategorias(); hideOverlay();

    startGeoAlways(); // GPS siempre

    if (navigator.onLine) { processQueue().catch(console.error); }
  });

  // =================== CAJEROS ===================
  async function loadCajeros(){
    try{
      const snap = await d.collection('CAJEROS').get();
      CAJEROS = snap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    }catch(e){ console.error('CAJEROS:', e); toast('No se pudieron cargar los cajeros.'); }
  }

  function wireSearch(){
    const input = pick('cj-search','of-search');
    const sug   = document.getElementById('cj-suggest') || document.getElementById('of-suggest') || (()=> {
      const div = document.createElement('div'); div.id = 'cj-suggest'; div.className='suggest'; (input?.parentNode||document.body).appendChild(div); return div;
    })();

    const render = items => {
      if (!items.length){ sug.classList.remove('show'); sug.innerHTML=''; return; }
      sug.innerHTML = items.slice(0,50).map(it=>{
        const dd = it.data||{}; const sub = [dd['DIRECCION'], dd['DISTRITO']].filter(Boolean).join(' · ');
        return `<div class="suggest-item" role="option" data-id="${it.id}">
          <div class="suggest-title">${it.id}</div><div class="suggest-sub">${sub||'&nbsp;'}</div></div>`;
      }).join('');
      sug.classList.add('show');
    };

    input?.addEventListener('input', ()=>{
      const q = normU(input.value);
      if (!q){ render([]); return; }
      render(CAJEROS.filter(o=>{
        const dd = o.data||{};
        return normU(o.id).includes(q) || normU(dd['DIRECCION']).includes(q) || normU(dd['DISTRITO']).includes(q);
      }));
    });

    input?.addEventListener('focus', ()=>{ if (input.value.trim()) input.dispatchEvent(new Event('input')); });

    document.addEventListener('click', e=>{ if (!sug.contains(e.target) && e.target!==input) { sug.classList.remove('show'); } });

    sug.addEventListener('click', e=>{
      const it = e.target.closest('.suggest-item'); if(!it) return;
      const f = CAJEROS.find(x=>x.id===it.dataset.id); if (f) applyCajero(f);
      // cerrar inmediatamente
      sug.classList.remove('show');
      sug.innerHTML = '';
      input?.blur();
    });
  }

  function applyCajero(item){
    const dta = item.data||{};
    const get = k => dta[k] ?? dta[k?.toUpperCase?.()] ?? dta[k?.toLowerCase?.()];

    setVal(item.id,         'cj-name','of-name');
    setVal(get('CATEGORIA'),'cj-categoria');
    setVal(get('CONSOLA'),  'cj-consola','of-consola');
    setVal(get('DIRECCION'),'cj-direccion','of-direccion');
    setVal(get('DISTRITO'), 'cj-distrito','of-distrito');
    setVal(get('ESTADO'),   'cj-estado');
    setVal(get('TERM ID'),  'cj-termid');
    setVal(get('TURBINA'),  'cj-turbina','of-turbina');

    // Geocodificación (Perú)
    if (window.google && google.maps){
      geocoder = geocoder || new google.maps.Geocoder();
      const addr = [get('DIRECCION'), get('DISTRITO'), 'Perú'].filter(Boolean).join(', ');
      geocoder.geocode({ address: addr }, (results, status)=>{
        if (status==='OK' && results && results[0]){
          const g = results[0].geometry.location;
          setCajeroMarker({ lat:g.lat(), lng:g.lng() });
        }
      });
    }
  }

  // =================== NOMENCLATURA (cascada) ===================
  function setSel(el, opts, placeholder){
    if (!el) return;
    el.innerHTML = `<option value="">${placeholder}</option>` + (opts||[]).join('');
    el.disabled = !opts || opts.length === 0;
  }
  function opt(id, nombre){
    const t = nombre || id;
    return `<option value="${id}" data-nombre="${t}">${t}</option>`;
  }

  async function loadCategorias(){
    const sel = document.getElementById('sel-cat');
    if (!sel) return;
    setSel(sel, [], 'Cargando…');
    try{
      const snap = await d.collection('NOMENCLATURA').orderBy('nombre').get();
      const rows = snap.docs
        .filter(doc => !doc.id.startsWith('__'))
        .map(doc => opt(doc.id, (doc.data()||{}).nombre || doc.id));
      setSel(sel, rows, 'Seleccione Categoría');
    }catch(e){
      console.error('NOMENCLATURA:', e);
      setSel(sel, [], 'Error');
    }
  }
  async function onCategoriaChange(){
    const catId = getVal('sel-cat');
    const selMotivo = document.getElementById('sel-motivo');
    const selNovedad = document.getElementById('sel-nov');
    const selDetalle = document.getElementById('sel-detalle');
    setSel(selMotivo, [], 'Seleccionar…');
    setSel(selNovedad, [], 'Seleccionar…');
    setSel(selDetalle, [], 'Seleccionar…');
    if (!catId) return;

    showOverlay('Cargando motivos…', catId);
    try{
      const qs = await d.collection('NOMENCLATURA').doc(catId).collection('MOTIVOS').orderBy('nombre').get();
      const rows = qs.docs.map(doc => opt(doc.id, (doc.data()||{}).nombre || doc.id));
      setSel(selMotivo, rows, 'Seleccione Motivo');
    }catch(e){
      console.error(e);
      setSel(selMotivo, [], 'Error');
    }
    hideOverlay();
  }
  async function onMotivoChange(){
    const catId = getVal('sel-cat');
    const motId = getVal('sel-motivo');
    const selNovedad = document.getElementById('sel-nov');
    const selDetalle = document.getElementById('sel-detalle');
    setSel(selNovedad, [], 'Seleccionar…');
    setSel(selDetalle, [], 'Seleccionar…');
    if (!catId || !motId) return;

    showOverlay('Cargando novedades…', $('#sel-motivo')?.selectedOptions[0]?.dataset.nombre || motId);
    try{
      const qs = await d.collection('NOMENCLATURA').doc(catId)
        .collection('MOTIVOS').doc(motId)
        .collection('NOVEDADES').orderBy('nombre').get();
      const rows = qs.docs.map(doc => opt(doc.id, (doc.data()||{}).nombre || doc.id));
      setSel(selNovedad, rows, 'Seleccione Novedad');
    }catch(e){
      console.error(e);
      setSel(selNovedad, [], 'Error');
    }
    hideOverlay();
  }
  async function onNovedadChange(){
    const catId = getVal('sel-cat');
    const motId = getVal('sel-motivo');
    const novId = getVal('sel-nov');
    const selDetalle = document.getElementById('sel-detalle');
    setSel(selDetalle, [], 'Seleccionar…');
    if (!catId || !motId || !novId) return;

    showOverlay('Cargando detalle…', $('#sel-nov')?.selectedOptions[0]?.dataset.nombre || novId);
    try{
      const qs = await d.collection('NOMENCLATURA').doc(catId)
        .collection('MOTIVOS').doc(motId)
        .collection('NOVEDADES').doc(novId)
        .collection('DETALLES').orderBy('nombre').get();
      const rows = qs.docs.map(doc => opt(doc.id, (doc.data()||{}).nombre || doc.id));
      setSel(selDetalle, rows, 'Detalle de Novedad');
    }catch(e){
      console.error(e);
      setSel(selDetalle, [], 'Error');
    }
    hideOverlay();
  }

  // =================== MAPAS & GPS ===================
  const GPS_FALLBACK = { lat: -12.177583726464341, lng: -77.0161780746462 };

  async function getCurrentPositionWithFallback(){
    if (!navigator.geolocation) return { ...GPS_FALLBACK, source: 'fallback' };
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'device' };
    } catch {
      return { ...GPS_FALLBACK, source: 'fallback' };
    }
  }

  function setCajeroMarker(pos){
    if (!atmMarker){
      atmMarker = new google.maps.Marker({ map, position: pos, title:'Cajero', icon:'http://maps.google.com/mapfiles/ms/icons/red-dot.png' });
    }else atmMarker.setPosition(pos);
    const b = new google.maps.LatLngBounds(); if (pos) b.extend(pos);
    if (meMarker && meMarker.getPosition()) b.extend(meMarker.getPosition());
    if (!b.isEmpty()) map.fitBounds(b);
  }

  function initUserWatch(){
    if (!('geolocation' in navigator)) return;
    if (watchId!==null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
      p=>{
        lastUserPos = { lat:p.coords.latitude, lng:p.coords.longitude };
        if (!meMarker) meMarker = new google.maps.Marker({ map, position: lastUserPos, title:'Tu ubicación', icon:'http://maps.google.com/mapfiles/ms/icons/blue-dot.png' });
        else meMarker.setPosition(lastUserPos);
      },
      e=>console.warn('GPS:', e.message), { enableHighAccuracy:true, maximumAge:0, timeout:12000 }
    );
  }
  function startGeoAlways(){
    try{ initUserWatch(); }catch{}
    document.addEventListener('pointerdown', function once(){
      if (!lastUserPos) initUserWatch();
      document.removeEventListener('pointerdown', once);
    }, { once:true });
  }

  // === Mapa: usa el MISMO nombre que el callback del HTML ===
  function initMapOfi(){
    if (!(window.google && google.maps)) return;
    const initial = { lat:-12.0453, lng:-77.0311 };
    const host = document.getElementById('map-ofi') || document.getElementById('map-cj') || document.body;
    map = new google.maps.Map(host, { center: initial, zoom: 13 });
    geocoder = new google.maps.Geocoder();
    setTimeout(()=> google.maps.event.trigger(map, 'resize'), 150);
  }
  // Define el callback en window lo antes posible (evita "initMapOfi no es función")
  window.initMapOfi = window.initMapOfi || initMapOfi;

  // =================== Cámara: wiring ===================
  function wireCamera(){
    $('#btn-foto')?.addEventListener('click', camOpen);
    camEls.close?.addEventListener('click', camClose);
    camEls.shoot?.addEventListener('click', camFromCamera);
    camEls.flip?.addEventListener('click', async ()=>{
      camFacing = camFacing==='environment' ? 'user' : 'environment';
      await camStart();
    });
    camEls.fileBtn?.addEventListener('click', ()=> camEls.filePick.click());
    camEls.filePick?.addEventListener('change', ()=> camFromFiles(camEls.filePick.files));
  }

  // =================== Cancelar / Enviar ===================
  function wireActions(){
    $('#btn-cancelar')?.addEventListener('click', async ()=>{
      try{
        setVal('', 'cj-search','of-search');
        ['cj-name','of-name','cj-categoria','cj-consola','cj-direccion','cj-distrito','cj-estado','cj-termid','cj-turbina']
          .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
        ['sel-cat','sel-motivo','sel-nov','sel-detalle','of-turno','cj-turno'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
        const com = document.getElementById('comentario'); if (com) com.value='';
        clearPhotos();
      }finally{
        window.location.href = 'menu.html';
      }
    });
    $('#btn-enviar')?.addEventListener('click', sendForm);
  }

  // ===== Subida de fotos (online) =====
  async function uploadAllPhotosOnline(uid, photos, prefix){
    const urls = [];
    for (let i=0;i<photos.length;i++){
      const p = photos[i];
      const ref = fbStorage.ref(`capturas/${uid}/${prefix || Date.now()}-${i}.jpg`);
      await ref.put(p, { contentType: p.type || 'image/jpeg' });
      urls.push(await ref.getDownloadURL());
      setProgress((i+1)/photos.length);
      const sub = $('#overlay-sub'); if (sub) sub.textContent = `Foto ${i+1} de ${photos.length}`;
    }
    return urls;
  }

  // ===== Enviar (online u offline) =====
  async function sendForm(){
    const user = a.currentUser;
    const cjName = getVal('cj-name','of-name');
    const turno  = getVal('of-turno','cj-turno');         // <- toma cualquiera de los dos ids
    const cat    = getVal('sel-cat');
    const mot    = getVal('sel-motivo');
    const nov    = getVal('sel-nov');
    const det    = getVal('sel-detalle');
    const comment= (document.getElementById('comentario')?.value || '').trim();

    if (!cjName){ toast('Selecciona un cajero.'); return; }
    if (!turno){ toast('Selecciona el turno.'); return; }
    if (!cat || !mot || !nov){ toast('Completa la clasificación (Categoría, Motivo y Novedad).'); return; }

    const pos = await getCurrentPositionWithFallback();
    lastUserPos = { lat: pos.lat, lng: pos.lng };

    const cjPos = atmMarker && atmMarker.getPosition() ? { lat: atmMarker.getPosition().lat(), lng: atmMarker.getPosition().lng() } : null;

    const photoBlobs = (PHOTOS||[]).map(p => p.blob).filter(Boolean);

    const payloadBase = {
      tipo: 'CAJERO',
      cajero: {
        id: cjName,
        categoria: getVal('cj-categoria'),
        consola:   getVal('cj-consola','of-consola'),
        direccion: getVal('cj-direccion','of-direccion'),
        distrito:  getVal('cj-distrito','of-distrito'),
        estado:    getVal('cj-estado'),
        term_id:   getVal('cj-termid'),
        turbina:   getVal('cj-turbina','of-turbina'),
        turno
      },
      clasificacion: {
        categoriaId:cat, categoria:($('#sel-cat')?.selectedOptions[0]?.dataset.nombre||''),
        motivoId:mot,   motivo:   ($('#sel-motivo')?.selectedOptions[0]?.dataset.nombre||''),
        novedadId:nov,  novedad:  ($('#sel-nov')?.selectedOptions[0]?.dataset.nombre||''),
        detalleId:det,  detalle:  ($('#sel-detalle')?.selectedOptions[0]?.dataset.nombre||'')
      },
      comentario: comment,
      geo: { usuario: lastUserPos || null, cajero: cjPos || null, source: pos.source || 'unknown' },
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (!navigator.onLine || !user){
      try{
        showOverlay('Guardando sin conexión…', 'Se enviará al reconectar');
        const photosStored = [];
        for (const b of photoBlobs) photosStored.push(await blobToStorable(b));
        const item = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), payload: payloadBase, photos: photosStored };
        await idbPut(item);
        hideOverlay(); clearPhotos();
        toast('Guardado sin conexión. Se enviará automáticamente al reconectar.');
        window.location.href = 'menu.html';
        return;
      }catch(e){
        hideOverlay(); console.error('Error guardando en cola offline:', e);
        toast('No se pudo guardar en la cola offline.'); return;
      }
    }

    try{
      showOverlay('Subiendo fotos…', 'Preparando');
      const urls = await uploadAllPhotosOnline(user.uid, photoBlobs);
      const payload = { ...payloadBase, fotos: urls, user: { uid: user.uid, email: user.email || null } };
      showOverlay('Enviando reporte…','Guardando en Firestore'); setProgress(1);
      await d.collection('reportes_cajeros').add(payload);
      hideOverlay(); toast('Reporte enviado correctamente.');
      clearPhotos(); window.location.href = 'menu.html';
    }catch(e){
      hideOverlay();
      console.warn('Fallo envío online, moviendo a cola:', e);
      try{
        showOverlay('Guardando en cola…','Reintentaremos al reconectar');
        const photosStored = [];
        for (const b of photoBlobs) photosStored.push(await blobToStorable(b));
        const item = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), payload: payloadBase, photos: photosStored };
        await idbPut(item);
        hideOverlay(); clearPhotos();
        toast('No hay conexión estable. Guardado en cola para reintento.');
        window.location.href = 'menu.html';
      }catch(e2){
        hideOverlay(); console.error('No se pudo guardar en cola:', e2);
        toast('No se pudo enviar ni guardar en cola. Intenta nuevamente.');
      }
    }
  }

  // Eventos de selects
  document.getElementById('sel-cat')?.addEventListener('change', onCategoriaChange);
  document.getElementById('sel-motivo')?.addEventListener('change', onMotivoChange);
  document.getElementById('sel-nov')?.addEventListener('change', onNovedadChange);
})();
