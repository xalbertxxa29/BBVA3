// ========== Sistema de logout con logs ==========

async function performLogout() {
  if (!window.auth) return;

  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      // Crear log de logout
      await createSessionLogLogout(currentUser.uid);
    }

    // Limpiar session storage
    sessionStorage.removeItem('lastLoginUser');
    sessionStorage.removeItem('sessionId');

    // Cerrar sesión en Firebase
    await auth.signOut();

    // Mostrar overlay de cierre
    showOverlay('Cerrando sesión…');
    
    setTimeout(() => {
      // Limpiar overlay
      hideOverlay();
      // Redirigir a login
      window.location.href = 'index.html';
    }, 500);

  } catch (error) {
    console.error('Error en logout:', error);
  }
}

async function createSessionLogLogout(userId) {
  const location = await getLocation();
  
  const logEntry = {
    userId: userId,
    action: 'logout',
    timestamp: new Date().toISOString(),
    date: new Date().toLocaleDateString('es-ES'),
    time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
    location: location,
    userAgent: navigator.userAgent,
    sessionId: sessionStorage.getItem('sessionId') || 'unknown'
  };

  // Guarda en localStorage bajo carpeta usuario
  const logsKey = `logs_${userId}`;
  let logs = JSON.parse(localStorage.getItem(logsKey)) || [];
  logs.push(logEntry);
  localStorage.setItem(logsKey, JSON.stringify(logs));

  // Intenta guardar en Firestore
  if (window.db) {
    try {
      await db.collection('session_logs').add(logEntry);
    } catch (e) {
      console.log('No se pudo guardar logout en Firestore:', e.message);
    }
  }

  return logEntry;
}

// Exporta función para usar globalmente
window.performLogout = performLogout;
