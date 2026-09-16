// Structured timing. One JSON line per request so durations can be grouped by
// action and phase in the log explorer, instead of inferred from wall-clock.
//
// SAFETY: this records names and durations only. Never pass tokens, passwords,
// document contents, prompts, model output, or any row data into a mark label.
export type Phase = "db" | "storage" | "external" | "docproc" | "other";

export interface Timer {
  mark: (phase: Phase, label: string, ms: number) => void;
  /** Wrap a promise, recording how long it took under `phase`. */
  track: <T>(phase: Phase, label: string, p: Promise<T>) => Promise<T>;
  done: (status: number, extra?: Record<string, unknown>) => void;
}

export function startTimer(fn: string, action: string): Timer {
  const t0 = performance.now();
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};

  const mark = (phase: Phase, label: string, ms: number) => {
    const key = `${phase}:${label}`;
    totals[key] = (totals[key] ?? 0) + ms;
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const track = async <T>(phase: Phase, label: string, p: Promise<T>): Promise<T> => {
    const s = performance.now();
    try { return await p; } finally { mark(phase, label, performance.now() - s); }
  };

  const done = (status: number, extra: Record<string, unknown> = {}) => {
    const total = Math.round(performance.now() - t0);
    const phases: Record<string, unknown> = {};
    for (const key of Object.keys(totals)) {
      phases[key] = { ms: Math.round(totals[key]), n: counts[key] };
    }
    // Single line, parseable: source='function_logs' message like {"t":"portal",...}
    console.log(JSON.stringify({ t: "portal", fn, action, status, total_ms: total, phases, ...extra }));
  };

  return { mark, track, done };
}
