import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Onboarding } from './components/Onboarding';
import { Account } from './pages/Account';
import { ClipView } from './pages/ClipView';
import { Editor } from './pages/Editor';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Record } from './pages/Record';
import { Settings } from './pages/Settings';
import { Uploads } from './pages/Uploads';
import { startLibrarySync } from './stores/library';
import { startRecorderSync } from './stores/recorder';
import { useSettings } from './stores/settings';
import { on } from './lib/ipc';

export function App() {
  useEffect(() => {
    void useSettings.getState().load();
    const stops = [startRecorderSync(), startLibrarySync()];
    const sub = on('settings-changed', () => void useSettings.getState().load());
    return () => {
      stops.forEach((s) => s());
      void sub.then((f) => f());
    };
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="library" element={<Library />} />
          <Route path="clips/:id" element={<ClipView />} />
          <Route path="clips/:id/edit" element={<Editor />} />
          <Route path="record" element={<Record />} />
          <Route path="uploads" element={<Uploads />} />
          <Route path="settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="settings/:section" element={<Settings />} />
          <Route path="account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Onboarding />
    </HashRouter>
  );
}
