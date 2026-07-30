document.addEventListener('DOMContentLoaded', () => {
  // mobile nav toggle
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  // active link highlighting based on current path
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href').replace(/\/$/, '') || '/';
    if (href === path) a.classList.add('active');
  });

  initInstallPrompt();
});

// ---- service worker registration (all pages) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

// ---- install prompt (Add to Home Screen / Install App) ----
let j2dDeferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  j2dDeferredPrompt = e;
  document.querySelectorAll('.install-btn').forEach(btn => { btn.style.display = 'inline-flex'; });
});

window.addEventListener('appinstalled', () => {
  j2dDeferredPrompt = null;
  document.querySelectorAll('.install-btn').forEach(btn => { btn.style.display = 'none'; });
  showToast('java2dex installed ✓');
});

function initInstallPrompt() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.querySelectorAll('.install-btn').forEach(btn => {
    if (isStandalone) { btn.style.display = 'none'; return; }
    btn.addEventListener('click', async () => {
      if (!j2dDeferredPrompt) {
        const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        showToast(isIOS
          ? 'On iPhone/iPad: tap Share, then "Add to Home Screen"'
          : 'Install option isn\'t available yet — try again in a moment, or use your browser\'s menu.');
        return;
      }
      j2dDeferredPrompt.prompt();
      const { outcome } = await j2dDeferredPrompt.userChoice;
      if (outcome === 'accepted') showToast('Installing java2dex…');
      j2dDeferredPrompt = null;
      btn.style.display = 'none';
    });
  });
}

// simple toast utility used across pages
function showToast(msg, duration = 2600) {
  let toastEl = document.getElementById('j2d-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'j2d-toast';
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), duration);
}
