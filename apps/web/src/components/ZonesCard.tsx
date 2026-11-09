import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { KOTCHA_NAMES, type ZonesResponse } from "@pulse/shared";
import { formatDate, formatDateTime } from "@/lib/format";
import { useConfirmZones, useSaveKotcha, useZones } from "@/lib/queries";
import { ageText } from "@/lib/stale";
import { barSpans, checkTops, parseTops, rangeText } from "@/lib/zones";
import { Modal } from "./Modal";
import { Button } from "./ui";

/** The sheet for Mark's copy of his Kotcha zones: the top of each zone in bpm. Saving is an explicit tap. */
export function KotchaSheet({ open, onClose, zones, max }: { open: boolean; onClose: () => void; zones: ZonesResponse["kotcha"]["zones"]; max: number | null }) {
  const save = useSaveKotcha();
  const [values, setValues] = useState<string[]>(zones.map((z) => String(z.top)));
  useEffect(() => {
    if (open) setValues(zones.map((z) => String(z.top)));
  }, [open, zones]);
  const errors = checkTops(values, max);
  return (
    <Modal open={open} onClose={() => { save.reset(); onClose(); }} labelledBy="kotcha-title">
      <p className="t-overline">Your copy of Kotcha</p>
      <h2 id="kotcha-title" className="t-card-title mb-1">Edit Kotcha zones</h2>
      <p className="t-secondary mb-3">Kotcha owns your zones. This is only a copy for reading here. Enter the top of each zone in bpm. Zone 5 is your max heart rate{max !== null ? `, ${max}` : ""}.</p>
      <div className="space-y-3">
        {KOTCHA_NAMES.map((name, i) => (
          <div key={name}>
            <label htmlFor={`zone-${i + 1}`} className="t-label block">Zone {i + 1} {name}, top (bpm)</label>
            <input
              id={`zone-${i + 1}`}
              inputMode="numeric"
              pattern="[0-9]*"
              value={values[i] ?? ""}
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
              aria-invalid={errors.some((x) => x.startsWith(`Zone ${i + 1} `))}
              className="mt-1 min-h-11 w-full rounded-2xl border border-border-strong bg-surface-2 px-4 text-[15px] text-foreground"
            />
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 text-[13px] font-medium text-danger">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      {save.isError && <p role="alert" className="mt-3 text-[13px] font-medium text-danger [overflow-wrap:anywhere]">{save.error.message}</p>}
      <div className="mt-4 flex flex-col gap-2">
        <Button disabled={errors.length > 0 || save.isPending} onClick={() => save.mutate(parseTops(values), { onSuccess: onClose })}>{save.isPending ? "Saving" : "Save"}</Button>
        <Button variant="secondary" onClick={() => { save.reset(); onClose(); }}>Cancel</Button>
      </div>
    </Modal>
  );
}

export function ZonesBody({ z, onEdit, onConfirm, confirming }: { z: ZonesResponse; onEdit: () => void; onConfirm: () => void; confirming: boolean }) {
  const spans = barSpans(z.kotcha.zones, z.garmin?.zones.floors[0] ?? null);
  const g = z.garmin;
  return (
    <>
      {z.warning && (
        <div role="alert" className="mb-3 rounded-2xl border border-[color:var(--state-warn)] p-3">
          <p className="flex items-start gap-2 text-[15px] font-semibold [overflow-wrap:anywhere]">
            <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-[color:var(--state-warn)]" />
            <span>{z.warning.text}</span>
          </p>
          <Button className="mt-3 w-full sm:w-auto" disabled={confirming} onClick={onConfirm}>{confirming ? "Saving" : "Kotcha is up to date"}</Button>
        </div>
      )}
      <ul className="space-y-3" aria-label="Kotcha heart rate zones">
        {z.kotcha.zones.map((k, i) => (
          <li key={k.zone} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium [overflow-wrap:anywhere]">Zone {k.zone} <span className="t-secondary font-normal">{k.name}</span></p>
              <p className="shrink-0 text-[15px] font-semibold">{rangeText(k.from, k.top)}</p>
            </div>
            <div className="relative mt-1 h-1 rounded-full bg-surface-2" role="img" aria-label={`Zone ${k.zone}, ${rangeText(k.from, k.top)}`}>
              <span className="absolute inset-y-0 rounded-full" style={{ left: `${spans[i]?.left ?? 0}%`, width: `${spans[i]?.width ?? 0}%`, background: "var(--ai-gradient)" }} />
            </div>
          </li>
        ))}
      </ul>
      {z.differences.length > 0 && (
        <ul className="mt-3 space-y-1">
          {z.differences.map((d) => <li key={d.zone} className="t-secondary">{d.text}</li>)}
        </ul>
      )}
      <p className="t-label mt-3">{z.kotcha.source === "manual" && z.kotcha.savedAt ? `Your copy of Kotcha, saved ${formatDateTime(z.kotcha.savedAt)}.` : "Starting values for your copy of Kotcha. Edit and save to make them yours."}</p>
      <Button variant="secondary" className="mt-2 w-full sm:w-auto" onClick={onEdit}>Edit Kotcha zones</Button>
      <details className="mt-1 min-w-0">
        <summary className="t-secondary flex min-h-11 cursor-pointer items-center">Garmin zones</summary>
        {g ? (
          <div className="space-y-2 pb-2 text-[15px]">
            {g.zones.usingDefault && <p className="font-semibold">Running uses your default profile</p>}
            <ul className="space-y-1">
              {g.ranges.map((r) => <li key={r.zone} className="flex justify-between gap-3"><span>Zone {r.zone}</span><span className="font-semibold">{rangeText(r.from, r.top).replace(/^up to/, "up to")}</span></li>)}
            </ul>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <div className="col-span-2"><dt className="t-label">Method</dt><dd className="[overflow-wrap:anywhere]">{g.zones.method.replaceAll("_", " ").toLowerCase()}</dd></div>
              <div><dt className="t-label">Lactate threshold</dt><dd>{g.zones.lactateThreshold ?? "--"} bpm</dd></div>
              <div><dt className="t-label">Max heart rate</dt><dd>{g.zones.max} bpm</dd></div>
              <div><dt className="t-label">Resting heart rate</dt><dd>{g.zones.resting ?? "--"} bpm</dd></div>
              <div><dt className="t-label">Zones since</dt><dd>{g.firstSeen ? formatDate(g.firstSeen) : "--"}</dd></div>
            </dl>
            {(g.stale || g.lastError) && g.ageMinutes !== null && <p className="t-label">Showing the last zones Garmin gave, {ageText(g.ageMinutes)} old{g.lastError ? ", the latest update failed" : ""}.</p>}
          </div>
        ) : (
          <p className="t-secondary pb-2">No Garmin zones yet. They appear after the next sync.</p>
        )}
      </details>
    </>
  );
}

/** Today: heart rate zones. Kotcha's copy is the main display, Garmin's zones sit under Details, and a Garmin change shows a warning. */
export function ZonesCard() {
  const q = useZones();
  const confirm = useConfirmZones();
  const [editing, setEditing] = useState(false);
  const z = q.data;
  return (
    <section className="card md:col-span-6" aria-labelledby="zones-title">
      <h2 id="zones-title" className="t-card-title mb-2">Heart rate zones</h2>
      {q.isPending && <p className="t-secondary">Loading</p>}
      {q.isError && !z && <p role="alert" className="text-danger">{q.error.message}</p>}
      {z && (
        <>
          <ZonesBody z={z} onEdit={() => setEditing(true)} onConfirm={() => confirm.mutate()} confirming={confirm.isPending} />
          {confirm.isError && <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{confirm.error.message}</p>}
          <KotchaSheet open={editing} onClose={() => setEditing(false)} zones={z.kotcha.zones} max={z.garmin?.zones.max ?? null} />
        </>
      )}
    </section>
  );
}
