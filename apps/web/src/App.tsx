import { APP_NAME } from "@pulse/shared";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "@/components/Layout";
import { EmptyState } from "@/components/ui";
import { useSession } from "@/lib/auth";
import { Ask } from "@/screens/Ask";
import { Login } from "@/screens/Login";
import { Placeholder } from "@/screens/Placeholder";
import { Proposals } from "@/screens/Proposals";
import { Races } from "@/screens/Races";
import { RaceLeadUp } from "@/screens/RaceLeadUp";
import { Settings } from "@/screens/Settings";
import { Today } from "@/screens/Today";
import { TrendsScreen } from "@/screens/Trends";
import { Week } from "@/screens/Week";

export function App() {
  const session = useSession();
  if (session.isPending) return <div className="p-4"><EmptyState>Loading</EmptyState></div>;
  if (session.isError) {
    return (
      <div className="p-4 space-y-2">
        <p role="alert">Cannot reach {APP_NAME}.</p>
        <button className="min-h-11 rounded-lg border border-border px-4" onClick={() => void session.refetch()}>Retry</button>
      </div>
    );
  }
  if (!session.data.authenticated) return <Login />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Today />} />
          <Route path="week" element={<Week />} />
          <Route path="races" element={<Races />} />
          <Route path="races/:key" element={<RaceLeadUp />} />
          <Route path="trends" element={<TrendsScreen />} />
          <Route path="ask" element={<Ask />} />
          <Route path="proposals" element={<Proposals />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Placeholder title="Not found" phase="no phase" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
