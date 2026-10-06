import { Layers, ShieldCheck } from "lucide-react";
import type { AgentInstall } from "./api";
import DescribedPicker, { type DescribedOption } from "./DescribedPicker";
import DocLink from "./DocLink";
import { CopyButton, Field } from "./ui";
import {
  effectiveTrust,
  fingerprint,
  fingerprintRows,
  pinnedCAFile,
  shortDigest,
  trustChoices,
  type HostOS,
  type Mode,
  type TrustChoice,
} from "./enrollmentCommands";
import "./enrollment-connection.css";

const modes: DescribedOption<Mode>[] = [
  {
    value: "restricted",
    label: "Restricted",
    description:
      "Reviewed components only. Files, destinations and listeners must be approved on the host.",
    icon: ShieldCheck,
  },
  {
    value: "full",
    label: "Full Vector",
    description:
      "Every Vector feature. People who publish pipelines get Vector's permissions on this host.",
    icon: Layers,
  },
];

/** The same described choice as account roles, with no preselected host grant. */
export function ModePicker({
  value,
  onChange,
  disabled,
}: {
  value: Mode | "";
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  return (
    <div className="enroll-mode-picker">
      <DescribedPicker
        label="How should Vectory manage this device?"
        menuLabel="Choose configuration mode"
        placeholder="Choose a mode"
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={modes}
      />
      <DocLink topic="installation" section="choose-configuration-capabilities">
        Compare the modes
      </DocLink>
    </div>
  );
}

const trustOptions: Record<TrustChoice, { label: string; summary: string }> = {
  pinned: {
    label: "Pin this server's CA",
    summary:
      "The host trusts only the CA whose fingerprint this page shows. The command carries the certificate, so there's nothing to copy first.",
  },
  file: {
    label: "A CA certificate file on the host",
    summary:
      "For a CA your team distributes. The agent reads the file on every connection, so keep it on the host.",
  },
  system: {
    label: "The host's trusted certificates",
    summary:
      "For a publicly trusted certificate, or a private CA the host already trusts.",
  },
};

/**
 * How the host checks the agent listener before it sends the token. The
 * command carries exactly the matching option (--ca-sha256, --ca-file PATH
 * or --ca-file=); a typed path is only a path, never a checked connection.
 */
export function TrustChoices({
  install,
  os,
  value,
  onChange,
  caFile,
  onCaFile,
  caFileProblem,
}: {
  install: AgentInstall;
  os: HostOS;
  value: TrustChoice | "";
  onChange: (choice: TrustChoice) => void;
  caFile: string;
  onCaFile: (path: string) => void;
  caFileProblem: string;
}) {
  const offered = trustChoices(install);
  const current = effectiveTrust(install, value || undefined);
  const example =
    os === "windows"
      ? "C:\\ProgramData\\Vectory\\server-ca.pem"
      : "/etc/vectory/server-ca.pem";
  return (
    <fieldset className="enroll-trust">
      <legend>How the host checks this server</legend>
      <p className="control-muted">
        Before it sends the token, the host checks the certificate of the agent
        listener ({install.agent_url || "port 8443"}). That&apos;s separate from
        your browser&apos;s trust and from the identity the device gets when it
        enrolls.
      </p>
      <div className="enroll-trust-options">
        {offered.map((choice, index) => (
          <label className="enroll-trust-option" key={choice}>
            <input
              type="radio"
              name="enroll-trust"
              value={choice}
              checked={current === choice}
              onChange={() => onChange(choice)}
            />
            <span>
              <strong>
                {trustOptions[choice].label}
                {index === 0 && (
                  <span className="enroll-default"> · default</span>
                )}
              </strong>
              <small>{trustOptions[choice].summary}</small>
            </span>
          </label>
        ))}
      </div>
      {current === "file" && (
        <Field
          label="CA certificate on the host"
          hint={
            caFileProblem ||
            "The PEM file of the CA that issued the agent listener's certificate. Ask whoever runs the server for it (with the development PKI, it's .local/pki/ca.pem on the server) and copy it over a channel you trust."
          }
        >
          <input
            value={caFile}
            aria-invalid={!!caFileProblem}
            onChange={(event) => onCaFile(event.target.value)}
            placeholder={example}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <DocLink topic="installation" section="trust-the-server-certificate">
        How hosts check the server
      </DocLink>
    </fieldset>
  );
}

export function isAbsoluteLocalFilePath(value: string, os: string): boolean {
  if (!value || value !== value.trim()) return false;
  if (os !== "windows")
    return (
      value.startsWith("/") &&
      value
        .slice(1)
        .split("/")
        .every(
          (segment) =>
            !!segment &&
            segment !== "." &&
            segment !== ".." &&
            !/[\u0000-\u001f]/.test(segment),
        )
    );
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.slice(3).split(/[\\/]/);
  return segments.every(
    (segment) =>
      !!segment &&
      segment !== "." &&
      segment !== ".." &&
      !/[\u0000-\u001f<>:"|?*]/.test(segment) &&
      !/[. ]$/.test(segment) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment),
  );
}

/** The whole CA fingerprint in rows of eight pairs, with Copy. */
function Fingerprint({ sha256 }: { sha256: string }) {
  return (
    <span className="enroll-fingerprint">
      <code aria-label={`SHA-256 fingerprint ${fingerprint(sha256)}`}>
        {fingerprintRows(sha256).map((row) => (
          <span key={row}>{row}</span>
        ))}
      </code>
      <CopyButton
        text={fingerprint(sha256)}
        variant="ghost compact"
        ariaLabel="Copy the CA fingerprint"
        copiedMessage="CA fingerprint copied."
      />
    </span>
  );
}

/**
 * What protects this install, with the real values: the installer's SHA-256,
 * the pinned server CA and the token's limits.
 */
export function SecurityReceipt({
  install,
  os,
  agentSha256,
  expiresAt,
  maxUses,
  trust,
  caFile,
}: {
  install: AgentInstall;
  os: HostOS;
  agentSha256: string | null;
  expiresAt: string;
  maxUses: number | null;
  trust: TrustChoice;
  caFile: string;
}) {
  const certificate = install.certificate;
  const expiry = new Date(expiresAt);
  const time = Number.isNaN(expiry.valueOf())
    ? "later"
    : expiry.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  return (
    <dl className="enroll-receipt" aria-label="What protects this install">
      {(os === "windows" ? install.windows_installer : install.installer) && (
        <div>
          <dt>Installer</dt>
          <dd>
            Runs only if its SHA-256 matches{" "}
            <code
              title={
                (os === "windows"
                  ? install.windows_installer
                  : install.installer)!.sha256
              }
            >
              {shortDigest(
                (os === "windows"
                  ? install.windows_installer
                  : install.installer)!.sha256,
              )}
            </code>
            . It checks the agent it downloads the same way.
          </dd>
        </div>
      )}
      {os === "windows" && agentSha256 && (
        <div>
          <dt>Agent</dt>
          <dd>
            The command stops unless vectory.exe matches SHA-256{" "}
            <code title={agentSha256}>{shortDigest(agentSha256)}</code>.
          </dd>
        </div>
      )}
      <div>
        <dt>Server</dt>
        <dd>
          {trust === "pinned" && certificate?.ca_sha256 ? (
            <>
              CA pinned
              {certificate.ca_name ? ` (${certificate.ca_name})` : ""}. The host
              trusts no other certificate for this server, and never the first
              one it happens to see.
              {os !== "windows" && (
                <>
                  {" "}
                  The command writes this CA to <code>{pinnedCAFile}</code>, so
                  the installer download is checked against it too.
                </>
              )}{" "}
              If setup asks you to compare, it shows this SHA-256 fingerprint:
              <Fingerprint sha256={certificate.ca_sha256} />
            </>
          ) : trust === "file" ? (
            <>
              Checked against the CA certificate at <code>{caFile}</code> on the
              host, for the download and for every connection after it. Put the
              file there before you run the command.
            </>
          ) : certificate?.publicly_trusted ? (
            <>
              Checked with the host&apos;s trusted certificates; this
              server&apos;s certificate is publicly trusted.
            </>
          ) : (
            <>
              Checked with the host&apos;s trusted certificates. This
              server&apos;s certificate comes from a private CA, so the host
              must already trust it, or setup stops before it asks for the
              token.
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Token</dt>
        <dd>
          {maxUses === 1
            ? "Works once"
            : maxUses
              ? `Works for ${maxUses} devices`
              : "Works for any number of devices"}{" "}
          and expires {time}. Setup asks for it, so it stays out of the command
          and shell history.
        </dd>
      </div>
    </dl>
  );
}
