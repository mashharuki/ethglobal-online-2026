import { useState } from "react";
import {
  type ReplayOutcome,
  type ReplaySummary,
  summarizeOutcomes,
} from "../attacks/concurrentReplay";

/**
 * Live "1 settled / 19 rejected" counter (tasks.md T109, SC-005). The run itself is injected so
 * the component stays free of wallet / gateway wiring.
 */
export default function AttackCounter(props: {
  parallelism: number;
  run: () => Promise<ReplayOutcome[]>;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "running"; startedAt: number }
    | { kind: "done"; summary: ReplaySummary; elapsedMs: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const start = async () => {
    const startedAt = performance.now();
    setState({ kind: "running", startedAt });
    try {
      const outcomes = await props.run();
      setState({
        kind: "done",
        summary: summarizeOutcomes(outcomes),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <h3>Concurrent replay ({props.parallelism} parallel)</h3>
        <button
          type="button"
          className="btn"
          onClick={() => void start()}
          disabled={state.kind === "running"}
        >
          {state.kind === "running" ? "firing…" : "Fire"}
        </button>
      </div>
      {state.kind === "done" && (
        <div className="space-y-1">
          <div className="text-2xl mono">
            <span style={{ color: "var(--ok)" }}>
              {state.summary.settled} settled
            </span>{" "}
            /{" "}
            <span style={{ color: "var(--deny)" }}>
              {state.summary.rejected} rejected
            </span>
            <span className="text-sm opacity-70"> in {state.elapsedMs} ms</span>
          </div>
          <ul className="flex flex-wrap gap-2 text-sm">
            {Object.entries(state.summary.codes).map(([code, n]) => (
              <li key={code} className="tag deny">
                {code} × {n}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.kind === "error" && <p className="error">{state.message}</p>}
    </div>
  );
}
