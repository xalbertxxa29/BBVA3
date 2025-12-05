// formularioof.js — Cámara integrada + subida diferida + cola offline + GPS fallback
(() => {
  // ===== Firebase singletons (expuestos por firebase-config.js) =====
  const a = window.auth;
  const d = window.db;
  const fbStorage = window.storage || firebase.storage();

  // (Opcional) Cache de Firestore en baja conexión
  if (firebase && firebase.firestore && typeof firebase.firestore === 'function') {
    try { firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(()=>{}); } catch(e) {}
  }

  // ===== Utils DOM / UI =====
  const $  = s => document.querySelector(s);
  const normU = t => (t||'').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();

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

  function showOverlay(msg='Cargando…', sub=''){{
    const m = $('#overlay-msg'), s = $('#overlay-sub');
    if (m) m.textContent = msg;
    if (s) s.textContent = sub || '';
    setProgress(0);
    $('#overlay').classList.add('active');
  }
  function hideOverlay(){ $('#overlay').classList.remove('active'); }
  function setProgress(f){ const el = $('#overlay-progress'); if (el) el.style.width = `${Math.max(0, Math.min(100, Math.round((f||0)*100)))}%`; }

  // ===== Estado general =====
  let OFFICES = [];
  let map, meMarker, ofiMarker, geocoder, watchId = null;
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
  const IDB_NAME = 'of-reports-db';
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
    const user = a.currentUser || await new Promise(res => {
      const unsub = a.onAuthStateChanged(u=>{ unsub(); res(u); });
    });
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
        await d.collection('reportes_oficinas').add(payload);
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
    $('#fecha').textContent = new Date().toLocaleDateString();
    await new Promise(res => a.onAuthStateChanged(u => { if(!u) location.href='index.html'; else res(); }));

    showOverlay('Cargando oficinas…','Leyendo colección OFICINAS');
    await loadOffices(); hideOverlay();

    wireSearch(); camGrabEls(); wireCamera(); wireActions();

    showOverlay('Cargando categorías…','Leyendo colección NOMENCLATURA');
    await loadCategorias(); hideOverlay();

    startGeoAlways(); // GPS siempre

    if (navigator.onLine) { processQueue().catch(console.error); }
  });

  // =================== OFICINAS ===================
  async function loadOffices(){
    try{
      const snap = await d.collection('OFICINAS').get();
      OFFICES = snap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    }catch(e){ console.error('OFICINAS:', e); toast('No se pudieron cargar las oficinas.'); }
  }
  function wireSearch(){
    const input = $('#of-search'), sug = $('#of-suggest');
    const render = items => {
      if (!items.length){ sug.classList.remove('show'); sug.innerHTML=''; return; }
      sug.innerHTML = items.slice(0,12).map(it=>{
        const dd = it.data||{}; const sub = [dd.DIRECCION, dd.DISTRITO].filter(Boolean).join(' · ');
        return `<div class="suggest-item" role="option" data-id="${it.id}">
          <div class="suggest-title">${it.id}</div><div class="suggest-sub">${sub||'&nbsp;'}</div></div>`;
      }).join('');
      sug.classList.add('show');
    };
    input.addEventListener('input', ()=>{
      const q = normU(input.value);
      if (!q){ render([]); return; }
      render(OFFICES.filter(o=>{
        const dd = o.data||{};
        return normU(o.id).includes(q) || normU(dd.DIRECCION).includes(q) || normU(dd.DISTRITO).includes(q);
      }));
    });
    input.addEventListener('focus', ()=>{ if (input.value.trim()) input.dispatchEvent(new Event('input')); });
    document.addEventListener('click', e=>{ if (!sug.contains(e.target) && e.target!==input) sug.classList.remove('show'); });
    sug.addEventListener('click', e=>{
      const it = e.target.closest('.suggest-item'); if(!it) return;
      const f = OFFICES.find(x=>x.id===it.dataset.id); if (f) applyOffice(f);
      sug.classList.remove('show');
    });
  }
  function applyOffice(ofi){
    const dta = ofi.data||{};
    $('#of-search').value  = ofi.id;
    $('#of-name').value    = ofi.id || '';
    $('#of-codigo').value  = dta.CODIGO || '';
    $('#of-direccion').value = dta.DIRECCION || '';
    $('#of-distrito').value  = dta.DISTRITO || '';
    $('#of-site').value      = dta.SITE || '';
    $('#of-consola').value   = dta.CONSOLA || '';
    $('#of-moto-save').value = dta['MOTO SAVE'] || '';
    $('#of-motorizado').value= dta['MOTORIZADO'] || '';
    $('#of-turbina').value   = dta['TURBINA'] || '';
    $('#of-status').value    = dta['STATUS DE FUNCIONAMIENTO'] || '';

    // Geocodificación (Perú)
    if (typeof google !== 'undefined' && google.maps) {
      const addr = [dta.DIRECCION, dta.DISTRITO, 'Perú'].filter(Boolean).join(', ');
      geocoder.geocode({ address: addr }, (results, status)=>{
        if (status==='OK' && results && results[0]){
          const g = results[0].geometry.location;
          setOfficeMarker({ lat:g.lat(), lng:g.lng() });
        }else if (dta.LATITUD && dta.LONGITUD){
          setOfficeMarker({ lat:+dta.LATITUD, lng:+dta.LONGITUD });
        }
      });
    }
  }

  // =================== NOMENCLATURA (cascada) ===================
  function setSel(el, opts, placeholder){
    el.innerHTML = `<option value="">${placeholder}</option>` + (opts||[]).join('');
    el.disabled = !opts || opts.length === 0;
  }
  function opt(id, nombre){
    const t = nombre || id;
    return `<option value="${id}" data-nombre="${t}">${t}</option>`;
  }

  async function loadCategorias(){
    const sel = $('#sel-cat');
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
    const catId = $('#sel-cat').value;
    const selMotivo = $('#sel-motivo'), selNovedad = $('#sel-nov'), selDetalle = $('#sel-detalle');
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
    const catId = $('#sel-cat').value;
    const motId = $('#sel-motivo').value;
    const selNovedad = $('#sel-nov'), selDetalle = $('#sel-detalle');
    setSel(selNovedad, [], 'Seleccionar…');
    setSel(selDetalle, [], 'Seleccionar…');
    if (!catId || !motId) return;

    showOverlay('Cargando novedades…', $('#sel-motivo').selectedOptions[0]?.dataset.nombre || motId);
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
    const catId = $('#sel-cat').value;
    const motId = $('#sel-motivo').value;
    const novId = $('#sel-nov').value;
    const selDetalle = $('#sel-detalle');
    setSel(selDetalle, [], 'Seleccionar…');
    if (!catId || !motId || !novId) return;

    showOverlay('Cargando detalle…', $('#sel-nov').selectedOptions[0]?.dataset.nombre || novId);
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

  function setOfficeMarker(pos){
    if (!ofiMarker){
      ofiMarker = new google.maps.Marker({ map, position: pos, title:'Oficina', icon:'http://maps.google.com/mapfiles/ms/icons/red-dot.png' });
    }else ofiMarker.setPosition(pos);
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
  function initMapOfi(){
    const initial = { lat:-12.0453, lng:-77.0311 };
    map = new google.maps.Map(document.getElementById('map-ofi'), { center: initial, zoom: 13 });
    geocoder = new google.maps.Geocoder();
    setTimeout(()=> google.maps.event.trigger(map, 'resize'), 150);
  }
  window.initMapOfi = initMapOfi; // callback del script de Maps

  // =================== Cámara: wiring ===================
  function wireCamera(){
    // Botón existente: abre cámara
    $('#btn-foto')?.addEventListener('click', camOpen);

    // NUEVO: adjuntar desde almacenamiento
    const pickMain = $('#file-pick-main');
    $('#btn-adjuntar')?.addEventListener('click', () => pickMain?.click());
    pickMain?.addEventListener('change', () => camFromFiles(pickMain.files));

    // Overlay de cámara (lo que ya tenías)
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
        $('#of-search').value = '';
        ['of-name','of-codigo','of-direccion','of-distrito','of-site','of-consola','of-moto-save','of-motorizado','of-turbina','of-status'].forEach(id=> { const el=$( '#'+id ); if(el) el.value=''; });
        ['sel-cat','sel-motivo','sel-nov','sel-detalle','of-turno'].forEach(id=>{ const el=$('#'+id); if(el) el.value=''; });
        $('#comentario').value = '';
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
    const ofName = $('#of-name').value.trim();
    const turno  = $('#of-turno').value;
    const cat    = $('#sel-cat').value;
    const mot    = $('#sel-motivo').value;
    const nov    = $('#sel-nov').value;
    const det    = $('#sel-detalle').value;
    const comment= $('#comentario').value.trim();

    if (!ofName){ toast('Selecciona una oficina.'); return; }
    if (!turno){ toast('Selecciona el turno.'); return; }
    if (!cat || !mot || !nov){ toast('Completa la clasificación (Categoría, Motivo y Novedad).'); return; }

    // Ubicación actual con fallback
    const pos = await getCurrentPositionWithFallback();
    lastUserPos = { lat: pos.lat, lng: pos.lng };

    const ofPos = ofiMarker && ofiMarker.getPosition() ? { lat: ofiMarker.getPosition().lat(), lng: ofiMarker.getPosition().lng() } : null;

    // Fotos como Blobs
    const photoBlobs = (PHOTOS||[]).map(p => p.blob).filter(Boolean);

    // Payload base (sin fotos todavía)
    const payloadBase = {
      tipo: 'OFICINA',
      oficina: {
        id: ofName,
        codigo: $('#of-codigo').value,
        direccion: $('#of-direccion').value,
        distrito: $('#of-distrito').value,
        site: $('#of-site').value,
        consola: $('#of-consola').value,
        moto_save: $('#of-moto-save').value,
        motorizado: $('#of-motorizado').value,
        turbina: $('#of-turbina').value,
        status_funcionamiento: $('#of-status').value,
        turno
      },
      clasificacion: {
        categoriaId:cat, categoria:($('#sel-cat').selectedOptions[0]?.dataset.nombre||''),
        motivoId:mot,   motivo:   ($('#sel-motivo').selectedOptions[0]?.dataset.nombre||''),
        novedadId:nov,  novedad:  ($('#sel-nov').selectedOptions[0]?.dataset.nombre||''),
        detalleId:det,  detalle:  ($('#sel-detalle').selectedOptions[0]?.dataset.nombre||'')
      },
      comentario: comment,
      geo: {
        usuario: lastUserPos || null,
        oficina: ofPos || null,
        source: pos.source || 'unknown'
      },
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    // Sin red o sin sesión → guardar en cola
    if (!navigator.onLine || !user){
      try{
        showOverlay('Guardando sin conexión…', 'Se enviará al reconectar');
        const photosStored = [];
        for (const b of photoBlobs) photosStored.push(await blobToStorable(b));
        const item = {
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          createdAt: Date.now(),
          payload: payloadBase,
          photos: photosStored
        };
        await idbPut(item);
        hideOverlay();
        clearPhotos();
        toast('Guardado sin conexión. Se enviará automáticamente al reconectar.');
        window.location.href = 'menu.html';
        return;
      }catch(e){
        hideOverlay();
        console.error('Error guardando en cola offline:', e);
        toast('No se pudo guardar en la cola offline.');
        return;
      }
    }

    // Online + sesión → subir y guardar
    try{
      showOverlay('Subiendo fotos…', 'Preparando');
      const urls = await uploadAllPhotosOnline(user.uid, photoBlobs);
      const payload = { ...payloadBase, fotos: urls, user: { uid: user.uid, email: user.email || null } };
      showOverlay('Enviando reporte…','Guardando en Firestore'); setProgress(1);
      await d.collection('reportes_oficinas').add(payload);
      hideOverlay();
      toast('Reporte enviado correctamente.');
      clearPhotos();
      window.location.href = 'menu.html';
    }catch(e){
      // Falla de red en el último paso → enviar a cola
      hideOverlay();
      console.warn('Fallo envío online, moviendo a cola:', e);
      try{
        showOverlay('Guardando en cola…','Reintentaremos al reconectar');
        const photosStored = [];
        for (const b of photoBlobs) photosStored.push(await blobToStorable(b));
        const item = {
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          createdAt: Date.now(),
          payload: payloadBase,
          photos: photosStored
        };
        await idbPut(item);
        hideOverlay();
        clearPhotos();
        toast('No hay conexión estable. Guardado en cola para reintento.');
        window.location.href = 'menu.html';
      }catch(e2){
        hideOverlay();
        console.error('No se pudo guardar en cola:', e2);
        toast('No se pudo enviar ni guardar en cola. Intenta nuevamente.');
      }
    }
  }

  // =================== Eventos de selects ===================
  $('#sel-cat')?.addEventListener('change', onCategoriaChange);
  $('#sel-motivo')?.addEventListener('change', onMotivoChange);
  $('#sel-nov')?.addEventListener('change', onNovedadChange);
})();
