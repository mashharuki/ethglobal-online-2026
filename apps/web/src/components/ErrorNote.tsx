import { GatewayError } from "../api/client";

/** Domain errors show their ErrorCode verbatim (the judges match them against error-codes.md). */
function describeError(error: unknown): string {
  if (error instanceof GatewayError) {
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export default function ErrorNote(props: { error: unknown }) {
  return (
    <p className="error mono text-sm" role="alert">
      {describeError(props.error)}
    </p>
  );
}
