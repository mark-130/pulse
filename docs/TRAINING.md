# Training model

## Ownership rule (D42)
- Mark's coaching app owns all training content: sessions, load, paces, tapers, recovery and race preparation. Garmin is the source of truth for what is scheduled.
- NGtive Split reports what is in Garmin. It never suggests, designs or critiques training, and the AI must not either. Asked for training advice, the chat answers with facts from Garmin and says to take the question to his coach.
- Race classes (A, B, C) only drive display, clash flags and data quality flags. The taper and recovery defaults below are reference notes. They are not used to produce recommendations, and nothing in the app shows them as advice.

## Sources of truth
- Workouts: Garmin, via get_scheduled_workouts. A separate plan app pushes into Garmin. NGtive Split (code name pulse) never talks to the plan app.
- Verified 07/11/2026: the plan app's workout appears in get_scheduled_workouts ("1h50 Long Run", 08/11/2026, 110 min). get_garmin_coach_workouts returned nothing, so Coach tools are not the source.
- Horizon: only one workout was visible across the next five weeks, so the plan app appears to push a short rolling window (inference). NGtive Split snapshots scheduled workouts daily, keeps history, and never assumes future workouts are visible.
- Races: the Garmin calendar, via get_calendar_events, synced by the Phase 1 Garmin job. Stored fields: title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, event_uuid.
- The app derives nothing about training from race dates or load: it reports what Garmin holds.

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
- Flags are information on the Races screen, the race detail screen and in the briefing. They are facts, not advice.
- Note: on 07/11/2026 Robin Hood Half (26/09/2027) was on Mark's Google calendar but not yet in Garmin. Garmin is the source, so it appears only once added in Garmin Connect.

## Priorities
Priority is a label Mark sets (or a suggestion until he does). It only drives display, the clash flags and the data quality flags. It does not drive any recommendation.
- A: goal race.
- B: secondary race.
- C: a race treated as a workout. It has no reference windows, so it never raises a taper or recovery clash.

## Reference notes: taper and recovery defaults (not used to produce recommendations, D42)
These came from the original specification and D30. In the app they exist only as reference windows for the clash flags below (a race inside another race's reference recovery window, or on or after the reference taper start of a later race). The volume and session lines are kept as notes for reading, never shown or turned into numbers.
- 10K, A: 7 days. Final week at 70 to 80 percent of normal volume. Keep short race pace work. Last hard session 4 to 5 days out. Easy day plus strides the day before.
- 10K, B: 4 days. About 20 percent volume cut. Last hard session 3 to 4 days out.
- Half, A: 10 days. Volume falls to about 75 percent, then about 60 percent. Last long run 8 to 10 days out and shortened. Keep a few race pace reps.
- Half, B: 5 to 7 days (built as 6, D30). About 25 percent volume cut. Last long run at least 7 days out.
- Marathon, B: not in the original defaults. Built as 10 days with about a 25 to 30 percent volume cut and the last long run at least 10 days out (D30).
- Marathon, A: 3 weeks. Week minus 3 about 85 percent, minus 2 about 65 percent, race week about 45 percent. Last long run 14 to 16 days out. Keep marathon pace segments.
- Trail half: as the road half, plus no hard downhill sessions in the final 7 days and one extra recovery day afterwards.
- C: no taper.
- Recovery after a race (easy running only): 10K 2 to 3 days, half 5 to 7 days, marathon 10 to 14 days, trail adds 1 to 2 days. No quality sessions until recovery completes. Built as 3, 6 and 12 days, trail adding 1 day for a 10K and 2 for a half or marathon. C races have no recovery window (D30).
- Distance classes: under 15 km uses the 10K rules, 15 km up to 35 km the half rules, 35 km and over the marathon rules. A race with no distance gets no reference window and a flag.

## Clash flags as built (D31, reworded in D42)
- Cluster: races from today on, linked when 21 days or fewer apart and either is a half or longer. A cluster is settled only when exactly one race is A and Mark has set that priority himself. Otherwise the Races screen asks him to choose, with a button per race. The warning states the fact, with no suggested dates and no advice.
- Recovery clash: a race inside the recovery window of an earlier race that is not C.
- Taper clash: a race on or after the taper start of a later race that is not C.
- Long run: a scheduled session of 90 minutes or more in the 7 days before a race that is not C (this is how the 08/11 long run flags the 14/11 10K). It states the session, its date and how many days before the race it falls, and nothing more.
- Past races stay for the recovery check but are left out of clusters.

## Cluster rules
- Cluster: two races 21 days or fewer apart where either is a half marathon or longer. The app says when their priorities are not settled (more than one A, or an A that Mark did not set) and offers a button per race to set it. It does not say how to run either race.
- A race inside the recovery window of an earlier race gets a warning.
- Fixtures from Mark's calendar on 07/11/2026 (tests only, never hard-code): Rhino 10K 14/11/2026 is 6 days after the 08/11 long run. Pierpont Plod half 14/03/2027 is 21 days before Brighton Marathon 04/04/2027. Scottish Half 15/08/2027 is 14 days before Sydney Marathon 29/08/2027. Expected: all three flagged.

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
- The status is shown on Today as built and signed off in 4a. Open question for Mark (D42): its labels (Go but easier, Swap for recovery, Rest) read as a recommendation about training, which the ownership rule says the app should not make. It is left as it was, the AI no longer quotes or restates it (the AI gets the readings it is built from), and Mark decides whether it stays, is renamed to a readings summary, or goes. Garmin and the plan app keep the real workouts.

## Race lead-up as built (4b, D42, D43)
- Code: apps/api/src/modules/races/leadup.ts. Read only, from the cache, no AI, the same result with AI off or at the cap. Shown on the race detail screen (Races, then Lead-up). Ask reads it through get_race_leadup.
- It shows days to go and up to 4 weeks ending with the race week (Monday to Sunday). A week that ended before this week, or starts beyond what the app sees in Garmin (about 14 days ahead, D41), is left out. For each week: the number of workouts scheduled in Garmin, their total scheduled minutes, the longest scheduled session, rest days (days with nothing scheduled and nothing recorded, among the days Garmin shows), and, for a week that has started, how many of the sessions dated up to today Garmin marks completed. A week that runs past the Garmin window says where the view ends. Distance is not shown because scheduled Garmin workouts carry a duration only.
- Flags, all factual: priority not set, start time unverified (before 05:00 in its own time zone), no goal time and the other data quality flags, another race within the cluster window (21 days, either a half or longer, D30), and a workout scheduled on race day. The cluster, recovery, taper and long run clash warnings that involve the race are listed as worded in the clash flags section.
- There are no suggested numbers, no targets, no taper advice and no "should" anywhere. A race with no priority set still shows its facts, with the flag "Priority not set."

## Plan app conflict risk
The plan app may re-push and overwrite a reschedule. Phase 3 includes a sync-conflict probe: Mark confirms a move of one test workout, then reports whether the plan app reverts it. The result is recorded in DECISIONS.md and decides whether reschedule proposals are offered.
