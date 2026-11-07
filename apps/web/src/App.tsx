import { APP_NAME } from "@pulse/shared";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "@/components/Layout";
import { EmptyState } from "@/components/ui";
import { useSession } from "@/lib/auth";
import { Login } from "@/screens/Login";
import { Placeholder } from "@/screens/Placeholder";
import { Settings } from "@/screens/Settings";
import { Today } from "@/screens/Today";

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
          <Route path="week" element={<Placeholder title="Week" phase="Phase 1" />} />
          <Route path="races" element={<Placeholder title="Races" phase="Phase 2" />} />
          <Route path="trends" element={<Placeholder title="Trends" phase="Phase 1" />} />
          <Route path="ask" element={<Placeholder title="Ask" phase="Phase 4" />} />
          <Route path="proposals" element={<Placeholder title="Proposals" phase="Phase 3" />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Placeholder title="Not found" phase="no phase" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
