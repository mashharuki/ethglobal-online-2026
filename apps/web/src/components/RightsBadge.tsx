/** Who the connected wallet is for this token, plus the two epochs as the chain reports them. */
export type RightsRole = "owner" | "creator" | "licensee" | "none";

export default function RightsBadge(props: {
  role: RightsRole;
  accessEpoch?: bigint;
  licenseEpoch?: bigint;
  readAtBlock?: bigint;
}) {
  const tone = props.role === "none" ? "warn" : "ok";
  const label = {
    owner: "current owner",
    creator: "creator",
    licensee: "licensee",
    none: "no rights",
  }[props.role];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`tag ${tone}`}>{label}</span>
      {props.accessEpoch !== undefined && (
        <span className="tag accent" title="RightsNFT.accessEpoch(tokenId)">
          owner epoch {props.accessEpoch.toString()}
        </span>
      )}
      {props.licenseEpoch !== undefined && (
        <span
          className="tag accent"
          title="RightsRegistry.licenseEpoch(tokenId)"
        >
          license epoch {props.licenseEpoch.toString()}
        </span>
      )}
      {props.readAtBlock !== undefined && (
        <span className="mono opacity-70">
          read at block {props.readAtBlock.toString()}
        </span>
      )}
    </div>
  );
}
