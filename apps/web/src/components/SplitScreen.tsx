import type { ReactNode } from "react";

/**
 * The transfer demo (tasks.md T109, US3 scenario 3): left = the previous owner's session,
 * right = a SURVIVE_TRANSFER licensee. Both panes run against the same token so the audience
 * sees one being refused (OWNER_EPOCH_MISMATCH) while the other keeps decrypting.
 */
export default function SplitScreen(props: {
  left: { title: string; body: ReactNode };
  right: { title: string; body: ReactNode };
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {[props.left, props.right].map((pane) => (
        <section key={pane.title} className="card space-y-2">
          <h3>{pane.title}</h3>
          {pane.body}
        </section>
      ))}
    </div>
  );
}
