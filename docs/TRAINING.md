# Training model

## Sources of truth
- Workouts: Garmin, via get_scheduled_workouts. A separate plan app pushes into Garmin. NGtive Split (code name pulse) never talks to the plan app.
- Verified 07/11/2026: the plan app's workout appears in get_scheduled_workouts ("1h50 Long Run", 08/11/2026, 110 min). get_garmin_coach_workouts returned nothing, so Coach tools are not the source.
- Horizon: only one workout was visible across the next five weeks, so the plan app appears to push a short rolling window (inference). NGtive Split snapshots scheduled workouts daily, keeps history, and never assumes future workouts are visible.
- Races: the Garmin calendar, via get_calendar_events, synced by the Phase 1 Garmin job. Stored fields: title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, event_uuid.
- Taper advice derives from race dates and recent load, never from future workouts.

## Race identification
- A race is a Garmin calendar event returned by get_calendar_events. Events with is_race false are kept and treated as C (see inference).
- NGtive Split never writes to the Garmin calendar. New races are added in Garmin Connect and arrive on the next sync.
- Pulse-owned metadata lives in the race_meta table (see docs/ARCHITECTURE.md): priority (A, B, C), type (road, trail), optional goal override, notes. Edits are local database writes and need no confirm tap. Garmin data is never changed by them.
- Inference defaults when race_meta has no value: priority B, A if primary_event is true, C if is_race is false. Distance from distance_m (title inference of marathon 42.195, half 21.0975, 10K 10 only if distance_m is missing, and then marked inferred). Goal from goal_time_seconds. Type trail if the title contains trail or Snowdonia, otherwise road.
- Races with any inferred priority or type appear in an "Unclassified" card until Mark sets them.
- Start times are shown in the race's own time_zone (Sydney, Antwerp), labelled with the zone. If start_time_local is missing (all-day event), show "start time unknown".

## Race data quality checks
- Start time before 05:00 in its own time zone: flag as unverified. Example on 07/11/2026: Antwerp shows 01:30 Europe/Paris.
- No goal time (goal_time_seconds empty and no override): flag.
- Flags are information on the Races screen and in the briefing. They do not block taper advice.
- Note: on 07/11/2026 Robin Hood Half (26/09/2027) was on Mark's Google calendar but not yet in Garmin. Garmin is the source, so it appears only once added in Garmin Connect.

## Priorities
- A: goal race. Full taper, full recovery.
- B: mini taper, trains through partly.
- C: treated as a workout. No taper. Replaces the nearest quality session.

## Taper defaults (editable in settings, advice only, not medical guidance)
- 10K, A: 7 days. Final week at 70 to 80 percent of normal volume. Keep short race pace work. Last hard session 4 to 5 days out. Easy day plus strides the day before.
- 10K, B: 4 days. About 20 percent volume cut. Last hard session 3 to 4 days out.
- Half, A: 10 days. Volume falls to about 75 percent, then about 60 percent. Last long run 8 to 10 days out and shortened. Keep a few race pace reps.
- Half, B: 5 to 7 days (built as 6, D30). About 25 percent volume cut. Last long run at least 7 days out.
- Marathon, B: not in the original defaults. Built as 10 days with about a 25 to 30 percent volume cut and the last long run at least 10 days out (D30).
- Marathon, A: 3 weeks. Week minus 3 about 85 percent, minus 2 about 65 percent, race week about 45 percent. Last long run 14 to 16 days out. Keep marathon pace segments.
- Trail half: as the road half, plus no hard downhill sessions in the final 7 days and one extra recovery day afterwards.
- C: no taper.
- Recovery after a race (easy running only): 10K 2 to 3 days, half 5 to 7 days, marathon 10 to 14 days, trail adds 1 to 2 days. No quality sessions until recovery completes. Built as 3, 6 and 12 days, trail adding 1 day for a 10K and 2 for a half or marathon. C races have no recovery window (D30).
- Distance classes: under 15 km uses the 10K rules, 15 km up to 35 km the half rules, 35 km and over the marathon rules. A race with no distance gets no taper advice and a flag.

## Warnings as built (D31)
- Cluster: races from today on, linked when 21 days or fewer apart and either is a half or longer. A cluster is settled only when exactly one race is A and Mark has set that priority himself. Otherwise the Races screen asks him to choose, with a button per race. Each race in the cluster gets a suggested taper start, computed as at least B so a C race still has a date to plan from.
- Recovery clash: a race inside the recovery window of an earlier race that is not C.
- Taper clash: a race on or after the taper start of a later race that is not C.
- Long run: a scheduled session of 90 minutes or more in the 7 days before a race that is not C (this is how the 08/11 long run flags the 14/11 10K).
- Past races stay for the recovery check but are left out of clusters.

## Cluster rules
- Cluster: two races 21 days or fewer apart where either is a half marathon or longer. Only one can be A. Ask Mark to set priorities. The earlier race is suggested as C or a controlled effort. The later race's taper takes precedence.
- A race inside the recovery window of an earlier race gets a warning.
- Fixtures from Mark's calendar on 07/11/2026 (tests only, never hard-code): Rhino 10K 14/11/2026 is 6 days after the 08/11 long run. Pierpont Plod half 14/03/2027 is 21 days before Brighton Marathon 04/04/2027. Scottish Half 15/08/2027 is 14 days before Sydney Marathon 29/08/2027. Expected: all three flagged, with a taper start date suggested for each.

## Daily readiness verdict (built in Phase 4a, D35)
- Computed in code (apps/api/src/modules/ai/verdict.ts). The AI never decides it and may only quote and explain it.
- Inputs: Garmin training readiness, sleep score, HRV against baseline, resting heart rate against its 7 day average, body battery, recent load, today's planned workout. Busy time from calendars joins in Phase 5.
- A measure dated before yesterday is too old and counts as missing. With fewer than 3 of the 6 measures the result is "No verdict" and says so.
- Each measure is ok (0 points), caution (1) or poor (2). Defaults, editable in the code constants:
  - Training readiness: 60 and over ok, 40 to 59 caution, under 40 poor.
  - Sleep score: 70 and over ok, 50 to 69 caution, under 50 poor.
  - HRV: at or above the baseline low ok. Below it by up to 10 percent caution, by more than 10 percent poor.
  - Resting heart rate: up to 3 bpm over the 7 day average ok, 4 to 6 caution, 7 or more poor.
  - Body battery (the day's highest): 70 and over ok, 40 to 69 caution, under 40 poor.
  - Load, acute to chronic ratio: up to 1.3 ok, up to 1.5 caution, above 1.5 poor.
- Output: Rest if 3 or more poor or 7 or more points. Swap for recovery if 2 or more poor or 4 or more points. Go but easier if 2 or more points or any poor. Otherwise Go as planned. A long or hard planned session (90 minutes or more, or a name with interval, tempo, threshold, repeat, hill, speed, fartlek, race or a pattern like 6x800) on a day of 3 or more points moves Go but easier to Swap for recovery.
- Reasons cite the number and its date, worst first, then today's planned session. The note "If you are ill, in pain or injured, rest and see a doctor or physio. This is not medical advice." is always shown.
- Illness, pain or injury: a question that mentions them gets a fixed reply to rest and see a doctor or physio, written in code, with no verdict and no model call.
- The verdict is advice. Garmin and the plan app keep the real workouts.

## Plan app conflict risk
The plan app may re-push and overwrite a reschedule. Phase 3 includes a sync-conflict probe: Mark confirms a move of one test workout, then reports whether the plan app reverts it. The result is recorded in DECISIONS.md and decides whether reschedule proposals are offered.
