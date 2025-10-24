// ========== Utilidad corta ==========
const $ = (s) => document.querySelector(s);

// ========== Footer ==========
document.addEventListener('DOMContentLoaded', () => {
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
});

// ========== Overlay helpers ==========
function showOverlay(msg = 'Procesando…') {
  const o = $('#overlay'); if (!o) return;
  const m = $('#overlay-msg'); if (m) m.textContent = msg;
  o.classList.add('active');
  o.setAttribute('aria-hidden', 'false');
}
function hideOverlay() {
  const o = $('#overlay'); if (!o) return;
  o.classList.remove('active');
  o.setAttribute('aria-hidden', 'true');
}

// ========== Banner de conectividad (opcional) ==========
(function netBanner(){
  let banner;
  const ensure = () => {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.className = 'net-banner';
    banner.innerHTML = '<div class="msg">Conexión restablecida</div>';
    document.body.appendChild(banner);
    return banner;
  };
  const show = (txt, off=false) => {
    const b = ensure();
    const msg = b.querySelector('.msg');
    msg.textContent = txt;
    msg.classList.toggle('off', off);
    b.classList.add('show');
    setTimeout(() => b.classList.remove('show'), 2500);
  };
  window.addEventListener('online',  () => show('Conexión restablecida'));
  window.addEventListener('offline', () => show('Sin conexión. Trabajando en modo offline', true));
})();

// ========== Autenticación ==========
document.addEventListener('DOMContentLoaded', () => {
  // Si Firebase ya está cargado, fuerza persistencia LOCAL (por si la init no lo hizo)
  if (window.auth && firebase?.auth?.Auth?.Persistence?.LOCAL) {
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
  }

  // Si YA hay sesión persistida, entra directo (incluso offline)
  if (window.auth) {
    auth.onAuthStateChanged((user) => {
      if (user) {
        showOverlay('Reanudando sesión…');
        // Pequeño delay para que el overlay se vea y evitar parpadeo
        setTimeout(() => { window.location.href = 'menu.html'; }, 50);
      }
    });
  }

  const form = document.getElementById('login-form');  // si tu HTML no tiene form, se ignora
  const loginBtn = $('#login-btn');
  const emailEl = $('#username');     // mismos ids que ya usas
  const passEl  = $('#password');

  async function doLogin(e){
    e?.preventDefault?.();

    const email = (emailEl?.value || '').trim();
    const password = (passEl?.value || '').trim();

    if (!email || !password){
      alert('Por favor, completa todos los campos.');
      return;
    }

    // Primer login requiere red si NO hay sesión previa
    if (!navigator.onLine && (!window.auth || !auth.currentUser)){
      alert('No hay conexión. El primer inicio de sesión requiere internet.');
      return;
    }

    loginBtn && (loginBtn.disabled = true);
    showOverlay('Validando credenciales…');

    try{
      // Persistencia local (por si acaso)
      if (firebase?.auth?.Auth?.Persistence?.LOCAL){
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      }

      const cred = await auth.signInWithEmailAndPassword(email, password);
      hideOverlay();
      if (cred.user){
        showOverlay('Cargando tu cuenta…');
        window.location.href = 'menu.html';
      }
    }catch(error){
      hideOverlay();

      // Caso típico de offline en primer login
      if (error?.code === 'auth/network-request-failed'){
        alert(
          'Error al iniciar sesión:\n' +
          'No se pudo llegar a Firebase.\n\n' +
          'Revisa:\n' +
          '• Firebase Console → Authentication → Authorized domains: agrega "localhost" y "127.0.0.1".\n' +
          '• Authentication → Sign-in method: habilita Email/Password.\n' +
          '• Conexión a internet (el primer login requiere red).'
        );
      } else {
        switch(error?.code){
          case 'auth/user-not-found':    alert('Usuario no encontrado.'); break;
          case 'auth/wrong-password':    alert('Contraseña incorrecta.'); break;
          case 'auth/too-many-requests': alert('Demasiados intentos. Intenta luego.'); break;
          default:                       alert('Error al iniciar sesión: ' + (error?.message || 'Desconocido')); break;
        }
      }
    } finally {
      loginBtn && (loginBtn.disabled = false);
    }
  }

  // Soporta envío por <form> o por click en botón
  form?.addEventListener('submit', doLogin);
  loginBtn?.addEventListener('click', doLogin);

  // Recuperar contraseña
  const fp = document.getElementById('forgot-password');
  fp?.addEventListener('click', async ()=>{
    const email = (emailEl?.value || '').trim();
    if(!email){ alert('Ingresa tu correo para enviarte el enlace.'); return; }
    try{
      showOverlay('Enviando enlace…');
      await auth.sendPasswordResetEmail(email);
      hideOverlay();
      alert('Enlace enviado a tu correo.');
    }catch(e){
      hideOverlay();
      alert('No se pudo enviar: ' + (e?.message || 'Error desconocido'));
    }
  });
});
