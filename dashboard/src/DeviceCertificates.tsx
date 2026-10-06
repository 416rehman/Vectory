import DocLink from "./DocLink";
import {
  day,
  previousSummary,
  shortFingerprint,
  type DeviceCaStatus,
} from "./deviceCaStatus";

/**
 * Settings → General: the certificate authority that issues device
 * certificates and, during a rotation, the previous one and who still uses it.
 */
export function DeviceCertificates({
  status,
}: {
  status: DeviceCaStatus | null;
}) {
  if (!status) return null;
  const { current, previous } = status;
  return (
    <section
      className="control-card"
      aria-labelledby="device-certificates-title"
    >
      <h2 id="device-certificates-title">Device certificates</h2>
      <dl className="control-summary-list">
        <div>
          <dt>Certificate authority</dt>
          <dd>
            <code title={current.sha256}>
              sha256 {shortFingerprint(current.sha256)}
            </code>{" "}
            · valid until {day(current.not_after)}
          </dd>
        </div>
        {previous && (
          <div>
            <dt>Previous authority</dt>
            <dd>
              <code title={previous.sha256}>
                sha256 {shortFingerprint(previous.sha256)}
              </code>{" "}
              · trusted until retired
            </dd>
          </div>
        )}
      </dl>
      <p className="control-muted">
        {previous
          ? previousSummary(previous)
          : "Every device certificate comes from this authority, and devices renew theirs automatically."}{" "}
        <DocLink
          topic="administer"
          section="rotate-the-device-certificate-authority"
        >
          Rotate the authority
        </DocLink>
      </p>
    </section>
  );
}
