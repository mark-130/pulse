import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { racesResponseSchema, syncStatusSchema, todayResponseSchema, trendsResponseSchema, weekResponseSchema } from "@pulse/shared";
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
