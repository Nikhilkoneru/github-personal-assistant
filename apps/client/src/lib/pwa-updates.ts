let isReloadingForUpdate = false;

type GpaWindow = Window & {
  __GPA_BUILD_VERSION__?: string;
};

const reloadForFreshShell = () => {
  if (typeof window === 'undefined' || isReloadingForUpdate) {
    return;
  }

  isReloadingForUpdate = true;
  window.location.reload();
};

export const registerPwaServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  const buildVersion = (window as GpaWindow).__GPA_BUILD_VERSION__?.trim() || 'dev';
  const registrationUrl = `./service-worker.js?v=${encodeURIComponent(buildVersion)}`;

  navigator.serviceWorker.addEventListener('controllerchange', reloadForFreshShell);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'FORCE_RELOAD') {
      reloadForFreshShell();
    }
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(registrationUrl, { updateViaCache: 'none' }).catch(() => undefined);
  });
};
