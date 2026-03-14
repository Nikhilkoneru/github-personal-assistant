import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './app';
import { AuthProvider } from './providers/auth-provider';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./service-worker.js').catch(() => undefined);
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
