import type { EpochLaneEvent } from "../graph/queries";

/**
 * Two lanes (tasks.md T109): Owner Epoch (bumped by every transfer) and License Epoch (bumped
 * only by policy updates / revocations). Indexed data from the Rights Graph - labelled as such.
 */
export default function EpochTimeline(props: { events: EpochLaneEvent[] }) {
  const lanes: Array<{ lane: EpochLaneEvent["lane"]; title: string }> = [
    { lane: "owner", title: "Owner Epoch (transfers)" },
    { lane: "license", title: "License Epoch (policy / revocation)" },
  ];
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3>Epoch timeline</h3>
        <span className="tag warn">indexed (Rights Graph)</span>
      </div>
      {lanes.map(({ lane, title }) => {
        const events = props.events.filter((e) => e.lane === lane);
        return (
          <div key={lane}>
            <div className="text-sm opacity-80">{title}</div>
            <ol className="flex flex-wrap gap-2 mt-1">
              {events.length === 0 && (
                <li className="text-sm opacity-60">no events indexed</li>
              )}
              {events.map((e) => (
                <li
                  key={`${lane}-${e.epoch}-${e.blockNumber}`}
                  className="tag accent"
                  title={`block ${e.blockNumber}`}
                >
                  #{e.epoch} {e.label}
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
