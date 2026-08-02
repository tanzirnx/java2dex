/* ============================================================
   Local lifecycle notifications — separate from remote Web Push.
   These fire instantly from the client (converting/success/error)
   and only need Notification permission, no server round-trip.
   Controlled by a simple on/off flag in localStorage.
   ============================================================ */
const J2D_ALERTS_KEY = 'java2dex_convert_alerts';

function j2dAlertsEnabled() {
  const v = localStorage.getItem(J2D_ALERTS_KEY);
  return v === null ? true : v === '1'; // default ON
}

function j2dSetAlertsEnabled(on) {
  localStorage.setItem(J2D_ALERTS_KEY, on ? '1' : '0');
}

// Requests Notification permission once, quietly. Never blocks the action
// it was called from — conversions proceed regardless of the answer.
let _j2dPermissionAsked = false;
async function j2dEnsureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  if (_j2dPermissionAsked) return Notification.permission === 'granted';
  _j2dPermissionAsked = true;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch (e) {
    return false;
  }
}

// Shows a local notification if allowed + enabled; always shows the in-page
// toast too, so feedback is never silently lost when notifications are off.
async function j2dNotify(title, body, toastMsg) {
  if (toastMsg && typeof showToast === 'function') showToast(toastMsg);
  if (!j2dAlertsEnabled()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
        return;
      }
    }
    new Notification(title, { body, icon: '/icons/icon-192.png' });
  } catch (e) { /* ignore — toast already covered it */ }
}
