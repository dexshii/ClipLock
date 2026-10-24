import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './index.css';
import { App } from './App';

// Keep the native context menu out of the app (it offers "Reload", which loses state).
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('input, textarea')) e.preventDefault();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
