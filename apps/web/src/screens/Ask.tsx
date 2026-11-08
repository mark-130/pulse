import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { AI_BUDGET_TEXT, AI_OFF_TEXT, type ChatMessage } from "@pulse/shared";
import { AiChip, Chip } from "@/components/Chip";
import { Orb } from "@/components/Orb";
import { Button } from "@/components/ui";
import { useAiStatus, useChat, useSendChat } from "@/lib/queries";

const SUGGESTIONS = ["How did I sleep?", "What is my next race?", "Should I run today?"];
const THREAD_KEY = "ask-thread";

function readThread(): string {
  try {
    return localStorage.getItem(THREAD_KEY) ?? "main";
  } catch {
    return "main";
  }
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <li className="ml-auto max-w-[85%] min-w-0 rounded-3xl rounded-br-lg border border-border-strong bg-surface-2 px-4 py-3 text-[15px] [overflow-wrap:anywhere]">
        <p className="whitespace-pre-line">{m.content}</p>
      </li>
    );
  }
  const ai = m.source === "ai";
  return (
    <li className={`mr-auto min-w-0 max-w-[92%] rounded-3xl rounded-tl-lg px-4 py-3 text-[15px] ${ai ? "card-briefing" : "card"}`}>
      <p className="mb-1 flex flex-wrap items-center gap-2">
        {ai ? <><Sparkles aria-hidden className="size-4 text-accent" /><AiChip /></> : <Chip>From the app, not AI</Chip>}
      </p>
      <p className="whitespace-pre-line leading-[1.6] [overflow-wrap:anywhere]">{m.content}</p>
      {m.tools.length > 0 && <p className="t-label mt-2 [overflow-wrap:anywhere]">Looked at: {[...new Set(m.tools)].join(", ")}</p>}
    </li>
  );
}

export function Ask() {
  const [params, setParams] = useSearchParams();
  const [thread, setThread] = useState(readThread);
  const [text, setText] = useState(params.get("q") ?? "");
  const chat = useChat(thread);
  const send = useSendChat(thread);
  const status = useAiStatus();
  const endRef = useRef<HTMLDivElement>(null);
  const messages = chat.data?.messages ?? [];
  const aiState = send.data?.state ?? chat.data?.state ?? status.data?.state ?? "ok";
  const off = aiState === "off";
  const budget = aiState === "budget";

  // A question from a Today chip is put in the box. It is never sent without a tap.
  useEffect(() => {
    if (params.has("q")) setParams({}, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, send.isPending]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || send.isPending) return;
    send.mutate(message, { onSuccess: (r) => r.state === "ok" && setText("") });
  }
  function newChat() {
    const id = `t${Date.now().toString(36)}`;
    try {
      localStorage.setItem(THREAD_KEY, id);
    } catch {
      /* the chat still works, it just will not be remembered */
    }
    setThread(id);
    send.reset();
    setText("");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Orb size={56} thinking={send.isPending} />
        <div className="min-w-0 flex-1">
          <h1 className="t-greeting !text-[28px]">Ask</h1>
          <p className="t-secondary">Questions about your training, answered from your own data.</p>
        </div>
      </div>

      {off && <p role="status" className="card">{AI_OFF_TEXT}. Set ANTHROPIC_API_KEY to switch Ask on. The rest of the app works without it.</p>}
      {budget && <p role="status" className="card">{AI_BUDGET_TEXT}. Ask returns next month.</p>}
      {status.data?.notice && !off && !budget && <p role="status" className="t-secondary">{status.data.notice}</p>}

      {chat.isError && <p role="alert" className="card">{chat.error.message}</p>}
      {messages.length === 0 && !chat.isPending && !off && !budget && (
        <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => setText(s)} className="inline-flex min-h-11 items-center rounded-full border border-border-strong bg-surface-2 px-4 text-[13px]">{s}</button>
          ))}
        </div>
      )}
      <ul className="space-y-3" aria-live="polite" aria-label="Conversation">
        {messages.map((m) => <Message key={m.id} m={m} />)}
        {send.isPending && (
          <li role="status" className="mr-auto rounded-3xl rounded-tl-lg border border-border bg-surface px-4 py-3 text-[15px]">Thinking.</li>
        )}
      </ul>
      {send.isError && (
        <p role="alert" className="text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{send.error.message}</p>
      )}

      <form onSubmit={submit} className="card space-y-3">
        <label htmlFor="ask-input" className="t-label block">Your question</label>
        <textarea
          id="ask-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={off || budget}
          className="min-h-11 w-full resize-y rounded-2xl border border-border-strong bg-surface-2 px-4 py-3 text-[15px] text-foreground disabled:opacity-60"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" className="w-full sm:w-auto" disabled={!text.trim() || send.isPending || off || budget}>{send.isPending ? "Thinking" : "Send"}</Button>
          <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={newChat} disabled={send.isPending || messages.length === 0}>New chat</Button>
        </div>
        <p className="t-label">Answers use only what the last sync stored. Ask cannot change anything. Not medical advice.</p>
        <Link to="/settings" className="inline-flex min-h-11 items-center text-[13px] underline">AI usage</Link>
      </form>
      <div ref={endRef} />
    </div>
  );
}
