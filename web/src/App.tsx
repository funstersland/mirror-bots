import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, type User } from './api.ts';
import { Shell } from './components/Shell.tsx';
import { AuthPage } from './pages/Auth.tsx';
import { CalendarPage } from './pages/Calendar.tsx';
import { FleetPage } from './pages/Fleet.tsx';
import { FleetProvider } from './store.tsx';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (!user) return <AuthPage onAuthed={setUser} />;

  return (
    <FleetProvider>
      <Shell user={user} onLogout={() => api.logout().finally(() => setUser(null))}>
        <Routes>
          <Route path="/" element={<FleetPage />} />
          <Route path="/hourly" element={<CalendarPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </FleetProvider>
  );
}
