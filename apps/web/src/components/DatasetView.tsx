import type { Dataset } from "../keygate/decrypt";

/** Decrypted plaintext, rendered by shape (CSV as a table, JSON / text verbatim). */
export default function DatasetView(props: { dataset: Dataset }) {
  const { dataset } = props;
  if (dataset.format === "binary") {
    return <p>binary dataset, {dataset.bytes.length} bytes decrypted</p>;
  }
  if (dataset.format === "csv" && dataset.text !== undefined) {
    const rows = dataset.text
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(","));
    return (
      <div className="overflow-x-auto">
        <table className="text-sm mono">
          <tbody>
            {rows.slice(0, 50).map((cells, i) => (
              <tr key={cells.join("|") + String(i)}>
                {cells.map((cell, j) => (
                  <td
                    key={`${String(i)}-${String(j)}`}
                    className="border px-2 py-1"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <pre className="mono text-sm whitespace-pre-wrap break-all">
      {dataset.text}
    </pre>
  );
}
