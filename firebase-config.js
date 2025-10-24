// firebase-config.js
// Requiere que antes se carguen en el HTML (Compat 10.9.0):
//   https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js
//   https://www.gstatic.com/firebasejs/10.9.0/firebase-auth-compat.js
//   https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore-compat.js
//   https://www.gstatic.com/firebasejs/10.9.0/firebase-storage-compat.js

// --- Configuración de tu proyecto ---
const firebaseConfig = {
  apiKey: "AIzaSyC6V--xlNwoe5iB9QD8Y2s2SQ4M0yR0MmQ",
  authDomain: "bbva-37617.firebaseapp.com",
  projectId: "bbva-37617",
  storageBucket: "bbva-37617.appspot.com", // <- appspot.com correcto
  messagingSenderId: "923249356091",
  appId: "1:923249356091:web:e2e8a77bb33a55c37e9b1e"
};

// --- Inicializar solo una vez ---
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// --- Instancias globales ---
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();

window.auth    = auth;
window.db      = db;
window.storage = storage;

// --- Auth: sesión persistente local (hasta cerrar sesión) ---
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
auth.useDeviceLanguage && auth.useDeviceLanguage();

// --- Firestore: cache offline + cola de escrituras + sync entre pestañas ---
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  // Si falla por “failed-precondition” (otra pestaña ya lo activó) o “unimplemented”, seguimos sin detener la app.
  console.warn("Firestore persistence no disponible:", err && err.code);
});

// (Opcional) entornos con proxies que bloquean WebSockets -> long-polling automático
try {
  db.settings({ experimentalAutoDetectLongPolling: true });
} catch (_) {
  // Ignorar si la versión no soporta esta opción
}

// --- Helper opcional: promesa que se resuelve cuando ya sabemos el estado de auth ---
window.onAuthReady = new Promise((resolve) => {
  const unsub = auth.onAuthStateChanged((u) => { unsub(); resolve(u); });
});
