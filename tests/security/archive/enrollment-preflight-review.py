"""Private stopped Windows CLI enrollment preflight and retained-intent review.

The TLS peer is synthetic and never issues an identity. No daemon or workload starts.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
import threading
import time
import uuid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sources():
    paths = list((ROOT / "agent/internal/agent").glob("*.go"))
    paths += list((ROOT / "agent/cmd/vectory").glob("*.go"))
    paths += [ROOT / "agent/go.mod", ROOT / "agent/go.sum"]
    return {p.relative_to(ROOT).as_posix(): sha(p) for p in sorted(paths)}


@contextmanager
def deny_delete(path):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(path), 0x80000000, 3, None, 3, 0, None)
    assert handle != wintypes.HANDLE(-1).value, ctypes.get_last_error()
    try:
        yield
    finally:
        assert kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    assert os.name == "nt"
    agent, output = args.agent.resolve(), args.output.resolve()
    assert output.is_relative_to(ROOT / ".local") and output.name.startswith("enrollment-preflight-")
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / ("fixture-" + str(uuid.uuid4()))
    fixture.mkdir()
    state_dir, managed_dir, bin_dir = [fixture / name for name in ("state", "managed", "bin")]
    managed_dir.mkdir(); bin_dir.mkdir()
    vector = ROOT / ".local/tools/vector-0.58.0/bin/vector.exe"
    binary = bin_dir / "vector.exe"
    shutil.copyfile(vector, binary)
    managed = managed_dir / "managed.json"
    managed.write_text('{"sources":{},"sinks":{}}\n', encoding="utf-8")

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic enrollment reviewer")])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .sign(key, hashes.SHA256()))
    ca_file, peer_key, corrected_ca = fixture / "server-ca.pem", fixture / "server-key.pem", fixture / "reviewed-ca.pem"
    ca_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    corrected_ca.write_bytes(ca_file.read_bytes())
    peer_key.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_3
    tls.load_cert_chain(ca_file, peer_key)
    peer = {"connections": 0, "requests": [], "response": "rejected"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            assert self.path == "/agent/v1/enroll"
            csr = x509.load_pem_x509_csr(body["csr_pem"].encode())
            public = csr.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
            peer["requests"].append({"request_id": body["request_id"], "name": body["name"],
                                      "public_key_sha256": hashlib.sha256(public).hexdigest(),
                                      "token_matches": body["token"] == "a" * 64,
                                      "path": self.path})
            if peer["response"] == "drop":
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            raw = b'{"synthetic":"not-an-enrollment-receipt"}'
            self.send_response(200 if peer["response"] == "malformed" else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers(); self.wfile.write(raw)

    class Peer(ThreadingHTTPServer):
        def get_request(self):
            conn, address = self.socket.accept()
            peer["connections"] += 1
            try:
                return tls.wrap_socket(conn, server_side=True), address
            except Exception:
                conn.close()
                raise

    server = Peer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    origin = "https://127.0.0.1:" + str(server.server_port)
    commands, groups = [], []
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "passed": False,
              "scope": "Independent stopped Windows CLI with synthetic state and a private TLS rejection peer. No real credentials, backend, identity issuance, workload, daemon, service or release mutation.",
              "candidate": {"path": str(agent), "sha256": sha(agent)},
              "harness": {"path": str(Path(__file__).resolve()), "sha256": sha(Path(__file__))},
              "source_sha256": sources(), "commands": commands, "groups": groups,
              "fixture_path": str(fixture), "fixture_removed": False}

    def call(*arguments, token="a" * 64):
        start = time.monotonic()
        result = subprocess.run([str(agent), *map(str, arguments)], input=token + "\n", text=True,
                                capture_output=True, timeout=40, creationflags=subprocess.CREATE_NO_WINDOW)
        commands.append({"arguments": [str(v).replace(str(fixture), "<private-fixture>").replace(origin, "<private-tls-origin>") for v in arguments],
                         "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - start, 3),
                         "stdout": result.stdout.strip(), "stderr": result.stderr.strip()})
        assert "a" * 64 not in result.stdout + result.stderr, "Synthetic token disclosed"
        return result

    def read(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def write(path, value):
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def snapshot():
        return {p.relative_to(state_dir).as_posix(): sha(p) for p in sorted(state_dir.rglob("*"))
                if p.is_file() and p.name != "agent.lock"}

    def dacl(path, add=False):
        assert path.resolve().is_relative_to(fixture.resolve())
        if add:
            result = subprocess.run(["icacls", str(path), "/grant", "*S-1-5-32-544:(R)"], capture_output=True,
                                    text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
            assert result.returncode == 0, result.stderr
        script = "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath '" + str(path).replace("'", "''") + "').Sddl"
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def label(path, add=False):
        assert path.resolve().is_relative_to(fixture.resolve())
        advapi, kernel = ctypes.WinDLL("advapi32", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
        pointer = ctypes.c_void_p
        advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
        advapi.GetSecurityDescriptorSacl.argtypes = [pointer, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(pointer), ctypes.POINTER(wintypes.BOOL)]
        advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, pointer, pointer, pointer, pointer]
        advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, pointer, pointer, pointer, ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
        advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [pointer, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
        kernel.LocalFree.argtypes = [pointer]
        if add:
            descriptor = pointer()
            assert advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NWNR;;;ME)", 1, ctypes.byref(descriptor), None)
            try:
                present, defaulted, sacl = wintypes.BOOL(), wintypes.BOOL(), pointer()
                assert advapi.GetSecurityDescriptorSacl(descriptor, ctypes.byref(present), ctypes.byref(sacl), ctypes.byref(defaulted)) and present.value
                assert advapi.SetNamedSecurityInfoW(str(path), 1, 0x10, None, None, None, sacl) == 0
            finally:
                kernel.LocalFree(descriptor)
        sacl, descriptor, rendered = pointer(), pointer(), pointer()
        assert advapi.GetNamedSecurityInfoW(str(path), 1, 0x10, None, None, None, ctypes.byref(sacl), ctypes.byref(descriptor)) == 0
        try:
            assert advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x10, ctypes.byref(rendered), None)
            return ctypes.wstring_at(rendered)
        finally:
            if rendered: kernel.LocalFree(rendered)
            kernel.LocalFree(descriptor)

    def access():
        paths = [state_dir, *sorted(state_dir.rglob("*"))]
        quoted = ",".join("'" + str(p).replace("'", "''") + "'" for p in paths)
        script = "$ErrorActionPreference='Stop'; @(" + quoted + ") | ForEach-Object { @{path=$_;sddl=(Get-Acl -LiteralPath $_).Sddl} } | ConvertTo-Json -Compress"
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode == 0, result.stderr
        descriptors = {item["path"]: item["sddl"] for item in json.loads(result.stdout)}
        return {p.relative_to(state_dir).as_posix(): {"owner_group_dacl": descriptors[str(p)], "mandatory_label": label(p)}
                for p in paths}

    def unchanged(name, *arguments, token="a" * 64):
        before, contacts, descriptor = snapshot(), peer["connections"], access()
        result = call(*arguments, token=token)
        assert result.returncode != 0, name + " unexpectedly succeeded"
        assert snapshot() == before, name + " changed protected bytes"
        assert access() == descriptor, name + " changed existing access"
        assert peer["connections"] == contacts, name + " made an outbound connection"
        groups.append({"name": name, "passed": True, "local_refusal": True, "outbound_connections": 0})
        return result

    def attempted(name, *arguments, expected_ca, expected_http=True):
        before, descriptor = snapshot(), access()
        calls = len(peer["requests"])
        result = call(*arguments)
        assert result.returncode != 0, "Synthetic peer never issues an identity"
        settings = read(state_dir / "settings.json")
        assert settings.get("ca_file", "") == str(expected_ca)
        assert settings["server"] == origin and settings["name"] == "synthetic-node"
        assert {k: v for k, v in settings.items() if k not in ("server", "name", "ca_file")} == initial_settings_unrelated
        assert read(state_dir / "state.json") == seeded_state
        after = snapshot()
        for path, digest in before.items():
            if path != "settings.json": assert after[path] == digest, (name, path)
        current_access = access()
        assert all(current_access[path] == value for path, value in descriptor.items())
        assert len(peer["requests"]) == calls + (1 if expected_http else 0)
        assert not (state_dir / "identity.json").exists()
        groups.append({"name": name, "passed": True, "identity_issued": False, "http_request_seen": expected_http,
                       "peer_response": peer["response"] if expected_http else "TLS not trusted; no HTTP request"})

    try:
        result = call("install", "--state-dir", state_dir, "--vector-binary", binary, "--managed-config", managed, "--adopt")
        assert result.returncode == 0, result.stderr
        settings_path, state_path = state_dir / "settings.json", state_dir / "state.json"
        settings = read(settings_path)
        settings["future_extension"] = {"exact": 18446744073709551615, "nested": [None, False, 9007199254740993]}
        settings["capability_policy"]["future_allowance"] = settings["future_extension"]
        write(settings_path, settings)
        initial_settings_unrelated = {k: v for k, v in settings.items() if k not in ("server", "name", "ca_file")}
        seeded_state = read(state_path)
        seeded_state["future_state"] = settings["future_extension"]
        write(state_path, seeded_state)
        (state_dir / "paused").write_bytes(b"Synthetic local pause\n")
        for path in [state_dir, settings_path, state_path, state_dir / "agent.lock"]:
            dacl(path, True); label(path, True)
        report["fixture_access"] = access()
        base = ("enroll", "--state-dir", state_dir, "--server", origin, "--id", "synthetic-node", "--token-stdin")
        recovery = ("recover-enrollment", "--state-dir", state_dir, "--server", origin, "--id", "synthetic-node", "--token-stdin")
        bad_ca = fixture / "not-a-certificate.pem"; bad_ca.write_text("synthetic not PEM\n")
        unchanged("Missing CA refuses before settings/key/pending mutation", *base, "--ca-file", fixture / "absent.pem")
        unchanged("Malformed CA refuses before settings/key/pending mutation", *base, "--ca-file", bad_ca)
        unchanged("Empty token refuses before enrollment settings are saved", *base, "--ca-file", ca_file, token="")
        unchanged("Oversized token refuses before enrollment settings are saved", *base, "--ca-file", ca_file, token="b" * 4097)
        unchanged("Invalid HTTPS origin refuses before local mutation", "enroll", "--state-dir", state_dir, "--server", "http://127.0.0.1", "--id", "synthetic-node", "--token-stdin", "--ca-file", ca_file)
        unchanged("Port zero refuses before persisting a new enrollment intent", "enroll", "--state-dir", state_dir, "--server", "https://127.0.0.1:0", "--id", "synthetic-node", "--token-stdin", "--ca-file", ca_file)
        unchanged("Empty device name refuses before local mutation", "enroll", "--state-dir", state_dir, "--server", origin, "--id", "", "--token-stdin", "--ca-file", ca_file)
        unchanged("Unsupported new machine name refuses before local mutation", "enroll", "--state-dir", state_dir, "--server", origin, "--id", "node/invalid", "--token-stdin", "--ca-file", ca_file)
        unchanged("Unexpected positional arguments refuse before local mutation", *base, "--ca-file", ca_file, "unexpected")
        unchanged("Recovery without identity refuses before changing trust", *recovery, "--ca-file", ca_file)
        identity = state_dir / "identity.json"
        identity.write_bytes(b"{synthetic malformed identity")
        unchanged("Malformed identity refuses without rewriting any settings", *base, "--ca-file", ca_file)
        identity.unlink()
        legacy_credentials = state_dir / "credentials.json"
        write(legacy_credentials, {"device_id": "synthetic-legacy-device"})
        unchanged("Legacy credentials without original private key are not treated as unenrolled", *base, "--ca-file", ca_file)
        legacy_credentials.unlink()
        write(settings_path, {**settings, "server": origin, "name": "synthetic-node", "ca_file": str(ca_file)})
        write(state_path, {**seeded_state, "device_id": "synthetic-existing-device", "highest_generation": 34,
                           "highest_policy_generation": 28, "secret_revision": 24,
                           "failed_generation": 34, "failed_effective_sha256": "b" * 64})
        unchanged("Missing credentials do not erase an existing durable device owner", *base, "--ca-file", ca_file)
        write(identity, {"credentials": {"device_id": "synthetic-existing-device"}, "private_key_pem": "synthetic-marker-not-a-key"})
        for name, extra in [("omitted CA", ()), ("explicit system trust", ("--ca-file=",)), ("different valid CA", ("--ca-file", corrected_ca))]:
            unchanged("Already enrolled with " + name + " preserves existing identity and settings", *base, *extra)
        unchanged("Recovery malformed trust refuses without changing existing identity or counters", *recovery, "--ca-file", bad_ca)
        staged = state_dir / "pending-recovery"
        staged.mkdir()
        write(staged / "enrollment.json", {"request_id": str(uuid.uuid4()), "server": origin, "name": "synthetic-node"})
        (staged / "private-key.pem").write_bytes(peer_key.read_bytes())
        unchanged("Orphaned recovery request and key cannot fabricate a new origin binding", *recovery, "--ca-file", ca_file)
        write(staged / "origin.json", {"old_device_id": "synthetic-existing-device", "token_sha256": hashlib.sha256(("b" * 64).encode()).hexdigest()})
        unchanged("Pending recovery rejects a different token without discarding its binding", *recovery, "--ca-file", ca_file)
        assert staged.resolve().parent == state_dir.resolve()
        for child in staged.iterdir(): child.unlink()
        staged.rmdir()
        identity.unlink()
        write(settings_path, settings); write(state_path, seeded_state)
        pending_path = state_dir / "enrollment.json"
        pending_path.write_bytes(b"{synthetic malformed pending")
        unchanged("Malformed pending intent refuses without creating a key or settings", *base, "--ca-file", ca_file)
        pending_path.unlink()
        write(pending_path, {"request_id": str(uuid.uuid4()), "server": origin, "name": "different-original-name"})
        unchanged("Different pending device name is never silently replaced", *base, "--ca-file", ca_file)
        pending_path.unlink()
        write(pending_path, {"request_id": str(uuid.uuid4()), "server": origin, "name": "synthetic-node"})
        unchanged("Matching pending request with missing key refuses instead of regenerating it", *base, "--ca-file", ca_file)
        pending_path.unlink()
        key_path = state_dir / "private-key.pem"
        key_path.write_bytes(b"synthetic malformed original private key")
        unchanged("Malformed original key is never replaced during enrollment retry", *base, "--ca-file", ca_file)
        key_path.unlink()
        import msvcrt
        with (state_dir / "agent.lock").open("r+b") as held:
            held.seek(0); msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
            try: unchanged("Operation lock prevents all enrollment effects", *base, "--ca-file", ca_file)
            finally: held.seek(0); msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)
        with deny_delete(settings_path):
            unchanged("Refused settings replacement sends nothing and creates no identity intent", *base, "--ca-file", ca_file)
        peer["response"] = "drop"
        attempted("First received request loses its connection without any response and retains durable intent", *base, "--ca-file", ca_file, expected_ca=ca_file)
        frozen = snapshot()
        first = peer["requests"][0]
        peer["response"] = "rejected"
        attempted("Omitted CA retry preserves saved private trust and original pending identity", *base, expected_ca=ca_file)
        assert snapshot() == frozen
        unchanged("Invalid explicit CA cannot damage a pending request", *base, "--ca-file", bad_ca)
        attempted("Explicit valid trust-file correction retains original request and key", *base, "--ca-file", corrected_ca, expected_ca=corrected_ca)
        attempted("Explicit empty CA selects OS trust without discarding pending identity", *base, "--ca-file=", expected_ca="", expected_http=False)
        attempted("Omitted CA after explicit OS trust retains that deliberate choice", *base, expected_ca="", expected_http=False)
        peer["response"] = "malformed"
        attempted("Malformed received response retains original pending identity and reviewed trust", *base, "--ca-file", ca_file, expected_ca=ca_file)
        assert all(item == first for item in peer["requests"]), "Retry request/key/name changed"
        unchanged("Pending request cannot be redirected to another server", "enroll", "--state-dir", state_dir, "--server", "https://127.0.0.1:1", "--id", "synthetic-node", "--token-stdin", "--ca-file", ca_file)
        report["peer_observations"] = {"tcp_connections": peer["connections"], "http_requests": peer["requests"], "identity_responses_issued": 0}
        report["source_end_sha256"] = sources()
        assert report["source_sha256"] == report["source_end_sha256"], "Source changed during execution"
        report["synthetic_token_absent_from_output"] = True
        report["counts"] = {"groups": len(groups), "commands": len(commands)}
        report["passed"] = True
        report["limits"] = ["Local error and pending-retention proof only; synthetic TLS peer receives then drops a request without replying, rejects later requests or returns malformed data. It never commits real enrollment or issues an identity.", "Current Windows maintenance operator with synthetic owner/group/DACL/MIC. No SCM/service, real fleet, workload, activation or Unix runtime.", "Existing late multi-file durability boundaries remain; request retention does not prove whether a real server committed."]
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        server.shutdown(); server.server_close(); server_thread.join(timeout=3)
        report["peer_stopped"] = not server_thread.is_alive()
        if report["passed"]:
            assert fixture.resolve().parent == output and fixture.name.startswith("fixture-")
            shutil.rmtree(fixture)
            report["fixture_removed"] = not fixture.exists()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "groups": len(groups), "commands": len(commands), "report": str(output / "report.json")}))


if __name__ == "__main__":
    main()
