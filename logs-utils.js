// logs-utils.js
// Utilidades para leer, analizar y exportar logs

/**
 * Obtiene todos los logs de un usuario
 * @param {string} userId - Email del usuario
 * @returns {Array} Array de eventos de sesión
 */
function getLogs(userId) {
  if (!userId) return [];
  const logs = localStorage.getItem(`logs_${userId}`);
  return logs ? JSON.parse(logs) : [];
}

/**
 * Obtiene solo los logins
 * @param {string} userId
 * @returns {Array}
 */
function getLoginLogs(userId) {
  return getLogs(userId).filter(l => l.action === 'login');
}

/**
 * Obtiene solo los logouts
 * @param {string} userId
 * @returns {Array}
 */
function getLogoutLogs(userId) {
  return getLogs(userId).filter(l => l.action === 'logout');
}

/**
 * Obtiene logs de una fecha específica
 * @param {string} userId
 * @param {string} dateStr - Formato: "11/12/2024"
 * @returns {Array}
 */
function getLogsByDate(userId, dateStr) {
  return getLogs(userId).filter(l => l.date === dateStr);
}

/**
 * Obtiene el último login
 * @param {string} userId
 * @returns {Object|null}
 */
function getLastLogin(userId) {
  const logins = getLoginLogs(userId);
  return logins.length > 0 ? logins[logins.length - 1] : null;
}

/**
 * Calcula duraciones de sesiones (en minutos)
 * @param {string} userId
 * @returns {Array} Array con duraciones
 */
function getSessionDurations(userId) {
  const logs = getLogs(userId);
  const sessions = [];
  
  for (let i = 0; i < logs.length - 1; i++) {
    if (logs[i].action === 'login' && logs[i + 1].action === 'logout') {
      const loginTime = new Date(logs[i].timestamp);
      const logoutTime = new Date(logs[i + 1].timestamp);
      const durationMs = logoutTime - loginTime;
      const durationMin = Math.round(durationMs / 60000);
      
      sessions.push({
        login: logs[i].time,
        logout: logs[i + 1].time,
        date: logs[i].date,
        duration: durationMin,
        location: logs[i].location
      });
    }
  }
  
  return sessions;
}

/**
 * Obtiene estadísticas de ubicación
 * @param {string} userId
 * @returns {Object}
 */
function getLocationStats(userId) {
  const logs = getLogs(userId);
  const locations = logs.filter(l => l.location?.latitude).map(l => l.location);
  
  if (locations.length === 0) {
    return { count: 0, message: 'No hay ubicaciones registradas' };
  }
  
  const latitudes = locations.map(l => l.latitude);
  const longitudes = locations.map(l => l.longitude);
  
  return {
    count: locations.length,
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLng: Math.min(...longitudes),
    maxLng: Math.max(...longitudes),
    firstLocation: locations[0],
    lastLocation: locations[locations.length - 1]
  };
}

/**
 * Genera un reporte legible en consola
 * @param {string} userId
 */
function generateReport(userId) {
  const logs = getLogs(userId);
  const logins = getLoginLogs(userId);
  const logouts = getLogoutLogs(userId);
  const durations = getSessionDurations(userId);
  
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b.duration, 0) / durations.length)
    : 0;
  
  console.log(`
┌────────────────────────────────────────┐
│  📊 REPORTE DE SESIONES                │
├────────────────────────────────────────┤
│ Usuario: ${userId}
│ Total eventos: ${logs.length}
│ Logins: ${logins.length}
│ Logouts: ${logouts.length}
│ Promedio sesión: ${avgDuration} minutos
│ Sesiones completadas: ${durations.length}
└────────────────────────────────────────┘
  `);
  
  if (durations.length > 0) {
    console.table(durations);
  }
}

/**
 * Exporta logs en formato JSON
 * @param {string} userId
 */
function exportLogsJSON(userId) {
  const logs = getLogs(userId);
  if (logs.length === 0) {
    alert('No hay logs para exportar');
    return;
  }
  
  const data = JSON.stringify(logs, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `logs_${userId}_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exporta logs en formato CSV
 * @param {string} userId
 */
function exportLogsCSV(userId) {
  const logs = getLogs(userId);
  if (logs.length === 0) {
    alert('No hay logs para exportar');
    return;
  }
  
  const headers = ['Fecha', 'Hora', 'Acción', 'Latitud', 'Longitud', 'Precisión', 'Session ID'];
  const rows = logs.map(log => [
    log.date,
    log.time,
    log.action,
    log.location?.latitude || '',
    log.location?.longitude || '',
    log.location?.accuracy || '',
    log.sessionId
  ]);
  
  let csv = headers.join(',') + '\n';
  rows.forEach(row => {
    csv += row.map(cell => `"${cell}"`).join(',') + '\n';
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `logs_${userId}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Limpia todos los logs de un usuario (¡Cuidado!)
 * @param {string} userId
 */
function clearUserLogs(userId) {
  if (confirm(`¿Estás seguro de que quieres eliminar todos los logs de ${userId}?`)) {
    localStorage.removeItem(`logs_${userId}`);
    console.log(`Logs de ${userId} eliminados`);
  }
}

/**
 * Limpia todos los logs de todos los usuarios
 */
function clearAllLogs() {
  if (confirm('¿Estás seguro de que quieres eliminar TODOS los logs?')) {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('logs_'));
    keys.forEach(k => localStorage.removeItem(k));
    console.log(`${keys.length} usuarios con logs eliminados`);
  }
}

// Exportar para uso global
window.getLogs = getLogs;
window.getLoginLogs = getLoginLogs;
window.getLogoutLogs = getLogoutLogs;
window.getLogsByDate = getLogsByDate;
window.getLastLogin = getLastLogin;
window.getSessionDurations = getSessionDurations;
window.getLocationStats = getLocationStats;
window.generateReport = generateReport;
window.exportLogsJSON = exportLogsJSON;
window.exportLogsCSV = exportLogsCSV;
window.clearUserLogs = clearUserLogs;
window.clearAllLogs = clearAllLogs;
