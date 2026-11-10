import { APP_NAME } from "@pulse/shared";
import { useState, type FormEvent } from "react";
import { Footer } from "@/components/Footer";
import { LogoMark } from "@/components/LogoMark";
import { Button } from "@/components/ui";
import { ApiRequestError } from "@/lib/api";
import { useAuthActions } from "@/lib/auth";

export function Login() {
  const { login } = useAuthActions();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col px-5 py-10">
      <div className="grid flex-1 place-items-center">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-5 p-6">
        <div className="flex items-center gap-3">
          <LogoMark size={36} />
          <h1 className="t-greeting !text-[24px]">{APP_NAME}</h1>
        </div>
        <label className="block">
          <span className="t-label mb-1 block">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-11 w-full rounded-full border border-border-strong bg-surface-2 px-4 text-[15px]"
          />
        </label>
        {error && (
          <p role="alert" className="text-[13px] font-medium text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
      </div>
      <Footer />
    </div>
  );
}
