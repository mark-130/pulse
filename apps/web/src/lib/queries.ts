import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiStatusSchema, buildInfoSchema, updateCheckResponseSchema, updateStatusSchema, briefingResponseSchema, chatThreadSchema, confirmResponseSchema, proposalsResponseSchema, type CreateProposalRequest, raceMetaResponseSchema, racesResponseSchema, type RaceMetaInput, syncStatusSchema, todayResponseSchema, trendsResponseSchema, weekResponseSchema } from "@pulse/shared";
import { z } from "zod";
import { api } from "./api";

const MIN = 60_000;

export const useToday = () => useQuery({ queryKey: ["today"], queryFn: () => api("/api/today", todayResponseSchema), refetchInterval: 5 * MIN });
export const useWeek = (start: string | null) =>
  useQuery({ queryKey: ["week", start], queryFn: () => api(start ? `/api/week?start=${start}` : "/api/week", weekResponseSchema) });
export const useTrends = () => useQuery({ queryKey: ["trends"], queryFn: () => api("/api/trends", trendsResponseSchema) });
export const useRaces = () => useQuery({ queryKey: ["races"], queryFn: () => api("/api/races", racesResponseSchema) });
export const useSyncStatus = () =>
  useQuery({ queryKey: ["sync-status"], queryFn: () => api("/api/sync/status", syncStatusSchema), refetchInterval: MIN });

/** Reads from Garmin into our database. Does not write to Garmin. */
export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/api/sync/garmin", z.object({ ok: z.boolean() }), { method: "POST" }),
    onSettled: () => void qc.invalidateQueries(),
  });
}

export function useOnline(): boolean {
  return useQuery({
    queryKey: ["online"],
    queryFn: () => navigator.onLine,
    staleTime: 0,
    refetchInterval: 15_000,
    networkMode: "always",
  }).data ?? true;
}

/** Local priority and type for one race. A write to our own database only, nothing goes to Garmin. */
export function useSetRaceMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string } & RaceMetaInput) => api("/api/races/meta", raceMetaResponseSchema, { method: "PUT", body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["races"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
}

export const useProposals = () => useQuery({ queryKey: ["proposals"], queryFn: () => api("/api/proposals", proposalsResponseSchema) });

function useRefreshProposals() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["proposals"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["week"] });
  };
}

/** Creating a proposal changes nothing in Garmin. It only adds a pending item to review. */
export function useCreateProposal() {
  const refresh = useRefreshProposals();
  return useMutation({ mutationFn: (body: CreateProposalRequest) => api("/api/proposals", confirmResponseSchema, { method: "POST", body }), onSettled: refresh });
}

export function useConfirmProposal() {
  const refresh = useRefreshProposals();
  return useMutation({ mutationFn: (id: string) => api(`/api/proposals/${id}/confirm`, confirmResponseSchema, { method: "POST" }), onSettled: refresh });
}

export function useRejectProposal() {
  const refresh = useRefreshProposals();
  return useMutation({ mutationFn: (id: string) => api(`/api/proposals/${id}/reject`, confirmResponseSchema, { method: "POST" }), onSettled: refresh });
}

export const useAiStatus = () => useQuery({ queryKey: ["ai-status"], queryFn: () => api("/api/ai/status", aiStatusSchema), refetchInterval: MIN });

export const useBriefing = () => useQuery({ queryKey: ["briefing"], queryFn: () => api("/api/briefing", briefingResponseSchema) });

/** Asks the server to write today's briefing if it is missing. The server allows one a day. */
export function useGenerateBriefing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/api/briefing/generate", briefingResponseSchema, { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(["briefing"], data);
      void qc.invalidateQueries({ queryKey: ["ai-status"] });
    },
  });
}

export const useChat = (thread: string) => useQuery({ queryKey: ["chat", thread], queryFn: () => api(`/api/chat?thread=${encodeURIComponent(thread)}`, chatThreadSchema) });

export function useSendChat(thread: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => api("/api/chat", chatThreadSchema, { method: "POST", body: { thread, message } }),
    onSuccess: (data) => {
      qc.setQueryData(["chat", thread], data);
      void qc.invalidateQueries({ queryKey: ["ai-status"] });
    },
  });
}

/** The running build. Public endpoint, so it also answers while the session is being re-read. */
export const useVersion = () => useQuery({ queryKey: ["version"], queryFn: () => api("/api/health/version", buildInfoSchema), staleTime: 5 * MIN });

export const useUpdateStatus = () => useQuery({ queryKey: ["update"], queryFn: () => api("/api/update", updateStatusSchema) });

/** Reads GHCR (or the server's 10 minute cache). Changes nothing. */
export function useCheckUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/api/update/check", updateCheckResponseSchema, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["update"] }),
  });
}
