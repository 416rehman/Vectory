import { useState } from "react";
import { Check, Copy, Layers, ShieldCheck } from "lucide-react";
import type { AgentInstall } from "./api";
import DocLink from "./DocLink";
import {
  fingerprint,
  fingerprintRows,
  shortDigest,
  type HostOS,
  type Mode,
} from "./enrollmentCommands";
import "./enrollment-connection.css";

const modes: {
  value: Mode;
  label: string;
  summary: string;
  icon: typeof Layers;
}[] = [
  {
    value: "restricted",
    label: "Restricted",
    summary:
      "Reviewed components only. Files, destinations and listeners must be approved on the host.",
    icon: ShieldCheck,
  },
  {
    value: "full",
    label: "Full Vector",
    summary:
      "Every Vector feature. People who publish pipelines get Vector's permissions on this host.",
    icon: Layers,
  },
];

/** The configuration mode as two cards; neither is chosen until the person picks one. */
export function ModeCards({
  value,
  onChange,
  disabled,
}: {
  value: Mode | "";
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="enroll-modes" disabled={disabled}>
      <legend>How should Vectory manage this device?</legend>
      <div className="enroll-mode-options">
        {modes.map(({ value: mode, label, summary, icon: Icon }) => (
          <label className="enroll-mode" key={mode}>
            <input
              type="radio"
              name="enroll-mode"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
            />
            <Icon size={18} aria-hidden="true" />
            <span>
              <strong>{label}</strong>
              <small>{summary}</small>
            </span>
          </label>
        ))}
      </div>
      <DocLink topic="installation" section="choose-configuration-capabilities">
        Compare the modes
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
  const [copied, setCopied] = useState(false);
  return (
    <span className="enroll-fingerprint">
      <code aria-label={`SHA-256 fingerprint ${fingerprint(sha256)}`}>
        {fingerprintRows(sha256).map((row) => (
          <span key={row}>{row}</span>
        ))}
      </code>
      <button
        type="button"
        className="button ghost compact"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(fingerprint(sha256));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
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
}: {
  install: AgentInstall;
  os: HostOS;
  agentSha256: string | null;
  expiresAt: string;
  maxUses: number | null;
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
      {os !== "windows" && install.installer && (
        <div>
          <dt>Installer</dt>
          <dd>
            Runs only if its SHA-256 matches{" "}
            <code title={install.installer.sha256}>
              {shortDigest(install.installer.sha256)}
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
          {certificate?.publicly_trusted ? (
            <>
              Verified with the host&apos;s trusted certificate authorities; the
              certificate is publicly trusted.
            </>
          ) : certificate?.ca_sha256 ? (
            <>
              CA pinned
              {certificate.ca_name ? ` (${certificate.ca_name})` : ""}. The host
              trusts no other certificate for this server, and never the first
              one it happens to see. If setup asks you to compare, it shows this
              SHA-256 fingerprint:
              <Fingerprint sha256={certificate.ca_sha256} />
            </>
          ) : (
            "The host must already trust this server's certificate."
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
