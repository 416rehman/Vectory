import { FileCheck2, Layers, ShieldCheck } from "lucide-react";
import DescribedPicker, { type DescribedOption } from "./DescribedPicker";
import DocLink from "./DocLink";
import { Field } from "./ui";
import "./enrollment-connection.css";

export type ConfigurationMode = "full" | "restricted";
const modes: readonly DescribedOption<ConfigurationMode>[] = [
  {
    value: "full",
    label: "Full Vector configuration",
    summary: "All features in the installed Vector build.",
    description:
      "Use all features in the installed Vector build, including files, network access, secret providers and command sources. Running the installation command grants pipeline publishers these capabilities with Vector's host permissions.",
    icon: Layers,
  },
  {
    value: "restricted",
    label: "Restricted components and resources",
    summary: "A limited component set with locally approved resources.",
    description:
      "Use the restricted component set. A host operator approves allowed files, network destinations and listeners on the device. The dashboard cannot widen these permissions.",
    icon: ShieldCheck,
  },
];
export function ConfigurationModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ConfigurationMode | "";
  onChange: (mode: ConfigurationMode) => void;
  disabled: boolean;
}) {
  return (
    <DescribedPicker
      label="Vector configuration mode"
      menuLabel="Choose configuration mode"
      placeholder="Choose how this device is managed"
      value={value}
      options={modes}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
const trustOptions: readonly DescribedOption<"system" | "file">[] = [
  {
    value: "system",
    label: "Use system trust",
    summary: "Already trusted by the device. No extra file needed.",
    description:
      "Use certificates already trusted by the device's operating system, including public authorities and certificates installed by your organization. No CA file is needed.",
    icon: ShieldCheck,
  },
  {
    value: "file",
    label: "Provide a certificate file",
    summary: "For a private CA the device does not already trust.",
    description:
      "Provide the public CA certificate that issued this server's HTTPS certificate, or its independently verified public certificate if it is deliberately self-signed. Use this when the device does not already trust the server.",
    icon: FileCheck2,
  },
];
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

export function RestrictedPolicyFile({
  value,
  onChange,
  os,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  os: string;
  disabled: boolean;
}) {
  const invalid = !!value && !isAbsoluteLocalFilePath(value, os);
  return (
    <section
      className="enrollment-policy"
      aria-label="Restricted mode allowances"
    >
      <p>
        A fresh restricted installation has no local file, network, or listener
        allowances. If this workload needs any, prepare an approved JSON policy
        file on the device and enter its path here. The dashboard cannot grant
        these permissions.
      </p>
      <Field
        label="Local allowance file on the device (optional)"
        hint={
          invalid
            ? os === "windows"
              ? "Use a full path on a local drive; network shares and relative paths are not supported."
              : "Use a full path on this device, not a relative path."
            : "The install command will read this existing file. This form does not create or upload it."
        }
      >
        <input
          value={value}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            os === "windows"
              ? "C:\\ProgramData\\Vectory\\capabilities.json"
              : "/etc/vectory/capabilities.json"
          }
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <DocLink topic="installation" section="configure-restricted-allowances">
        How to prepare local allowances
      </DocLink>
    </section>
  );
}

export function ServerCertificateTrust({
  privateCA,
  onPrivateCAChange,
  caFile,
  onCaFileChange,
  os,
  disabled,
}: {
  privateCA: boolean;
  onPrivateCAChange: (value: boolean) => void;
  caFile: string;
  onCaFileChange: (value: string) => void;
  os: string;
  disabled: boolean;
}) {
  return (
    <section className="enrollment-trust" aria-label="Server certificate setup">
      <DescribedPicker
        label="Server certificate trust"
        menuLabel="Choose certificate trust"
        value={privateCA ? "file" : "system"}
        options={trustOptions}
        onChange={(value) => onPrivateCAChange(value === "file")}
        disabled={disabled}
      />
      <p className="enrollment-trust-purpose">
        The agent verifies this server before sending its enrollment token.
      </p>
      {privateCA && (
        <div className="enrollment-certificate-file">
          <p className="enrollment-certificate-preparation">
            First get the <strong>public CA certificate</strong> that issued
            this server&apos;s agent HTTPS certificate. If you run the server,
            use the issuing CA from your server setup; otherwise, request it
            from the server administrator through a trusted channel. Copy the
            PEM file to the device before entering its path.
          </p>
          <Field
            label="CA certificate path on the device"
            hint={
              caFile && !isAbsoluteLocalFilePath(caFile, os)
                ? os === "windows"
                  ? "Use a full path on a local drive, such as C:\\ProgramData\\VectoryTrust\\server-ca.pem. UNC shares and device paths are not supported here."
                  : "Enter the full path on the device. Relative paths can fail when the agent runs as a service."
                : "Enter the full path to that public PEM file on the device, not the path on the server. On Windows, keep it on a local drive."
            }
          >
            <input
              value={caFile}
              aria-invalid={!isAbsoluteLocalFilePath(caFile, os)}
              required
              disabled={disabled}
              onChange={(event) => onCaFileChange(event.target.value)}
              placeholder={
                os === "windows"
                  ? "C:\\ProgramData\\VectoryTrust\\server-ca.pem"
                  : "/etc/vectory/trust/server-ca.pem"
              }
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <p className="enrollment-certificate-retain">
            Keep this file at the same path, readable by the agent. It is needed
            for future connections; entering a path does not upload or verify
            the file.
          </p>
        </div>
      )}
      <details className="enrollment-trust-help">
        <summary>
          {privateCA
            ? "I run the server — how do I find the right file?"
            : "Which certificate option should I choose?"}
        </summary>
        <div>
          {privateCA ? (
            <>
              <ol>
                <li>
                  Check which certificate your server uses for its agent HTTPS
                  listener. In a direct deployment this is configured with{" "}
                  <code>VECTORY_TLS_CERT</code>; the supplied Compose setup uses{" "}
                  <code>VECTORY_TLS_CERT_FILE</code>. Get the public PEM
                  certificate or chain for the authority that issued it. For a
                  deliberately self-signed listener, use its independently
                  verified public certificate.
                </li>
                <li>
                  If you used Vectory&apos;s development certificate script, use{" "}
                  <code>ca.pem</code> from its output folder (by default{" "}
                  <code>.local/pki/ca.pem</code> on the server).
                </li>
                <li>
                  Copy the public file to the device through trusted access or
                  provisioning. Compare its SHA-256 certificate fingerprint with
                  the issuer&apos;s trusted copy, then keep it at a stable path
                  readable by the agent.
                </li>
              </ol>
              <p>
                Copy only public certificates, never private keys. The separate{" "}
                <code>device-ca.pem</code> identifies enrolled devices; it is
                not the certificate for trusting the server.
              </p>
            </>
          ) : (
            <p>
              Choose system trust if this device already trusts the agent
              listener&apos;s certificate through its operating system. If it
              does not, select a certificate file and copy the issuing public CA
              to the device. Opening this dashboard in your browser does not
              confirm trust on another device.
            </p>
          )}
          <DocLink topic="installation" section="trust-the-server-certificate">
            Server certificate setup guide
          </DocLink>
        </div>
      </details>
    </section>
  );
}
