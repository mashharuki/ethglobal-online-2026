import type { ReactNode } from "react";
import { hashscanAddressUrl, hashscanTxUrl } from "../lib/explorer";

/**
 * Every wallet address / tx hash shown in the app routes through this to HashScan
 * (Hedera Testnet's block explorer) - opens in a new tab, never navigates the app away.
 */
export default function ExplorerLink(props: {
  kind: "address" | "tx";
  value: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const href =
    props.kind === "address"
      ? hashscanAddressUrl(props.value)
      : hashscanTxUrl(props.value);
  const className = ["explorer-link", props.className]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      title={props.title}
    >
      {props.children}
    </a>
  );
}
