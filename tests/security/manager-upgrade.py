#!/usr/bin/env python3
"""Qualify a published 0.1.1 manager upgrade against actual candidate images.

Maintainer/CI fixture only, on a Linux Docker host. It uses a private synthetic
instance, real Vector validation, verified listener TLS and an actual mTLS
identity. It never installs a host service or claims Vector activation. Public
evidence contains hashes and identities only; the preserved backup is private.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

BASELINE_URL = "https://github.com/416rehman/Vectory/releases/download/v0.1.1/vectory-server-image.tar.gz"
BASELINE_SHA = "4fe16c4db60e04f34640f6d70679ecc082a1413c8d648da92a9b053f8645711c"
BASELINE_IMAGE_IDS = {
    "sha256:522738eaa0b2f1173232d0e56c888aa178c8c84087e1997892b0a3bf9c8bc9a7",
    "sha256:20ecab168bb3b433f7e06497e2a185f2fcfeffe8dcb17893ba7eab03c6d59513",
}
SOURCE = "https://github.com/416rehman/Vectory"
MAX_DOWNLOAD = 1 << 30


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            value.update(chunk)
    return value.hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(arguments, timeout=60):
    # Commands are fixed executable/argument arrays, never string-built shell
    # expressions. Output can contain fixture credentials and stays private.
    result = subprocess.run(arguments, capture_output=True, timeout=timeout)
    require(result.returncode == 0, f"Fixture command failed: {Path(arguments[0]).name} {arguments[1] if len(arguments) > 1 else ''}")
    return result.stdout


class HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, location):
        require(urllib.parse.urlsplit(location).scheme == "https", "Release download tried a non-HTTPS redirect")
        return super().redirect_request(request, fp, code, message, headers, location)


def baseline_archive(supplied, trial):
    path = supplied.resolve() if supplied else trial / "published-0.1.1-server.tar.gz"
    if not supplied:
        opener = urllib.request.build_opener(HTTPSRedirects())
        started = time.monotonic()
        with opener.open(BASELINE_URL, timeout=30) as response, path.open("xb") as output:
            size = 0
            while chunk := response.read(1 << 20):
                size += len(chunk)
                require(size <= MAX_DOWNLOAD and time.monotonic() - started < 180, "Published baseline download exceeded its bounds")
                output.write(chunk)
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_DOWNLOAD, "Published baseline archive is unsafe")
    require(digest(path) == BASELINE_SHA, "Published 0.1.1 baseline archive does not match its pinned checksum")
    return path


def archive_image_ids(path):
    """Bind Docker 29's optional OCI index identity to the pinned archive too."""
    identities = set(BASELINE_IMAGE_IDS)
    with tarfile.open(path, "r:gz") as archive:
        try:
            member = archive.getmember("index.json")
        except KeyError:
            return identities
        require(member.isfile() and member.size <= 2 << 20, "Baseline OCI index exceeded its metadata bound")
        raw = archive.extractfile(member).read((2 << 20) + 1)
        require(len(raw) <= 2 << 20, "Baseline OCI index exceeded its metadata bound")
        index = json.loads(raw)
        require(index.get("schemaVersion") == 2, "Unsupported baseline OCI index")
        identities.add("sha256:" + hashlib.sha256(raw).hexdigest())
    return identities


def missing_resource(result):
    diagnostic = result.stderr.decode(errors="replace").lower()
    return result.returncode != 0 and any(absent in diagnostic for absent in ("no such object", "no such container", "no such network", "no such volume", "no such image"))


def evidence_destinations(output, backup):
    # Resolve physical ancestors before separation checks. A link into an
    # artifact directory must never cause a private key backup to be uploaded.
    output, backup = output.absolute(), backup.absolute()
    for path in (output, backup):
        require(not any(parent.is_symlink() for parent in (path, *path.parents)), "Evidence and backup paths must not traverse links")
    output, backup = output.resolve(strict=False), backup.resolve(strict=False)
    require(not output.exists() and not backup.exists(), "Evidence and private backup destinations must be new")
    require(not backup.is_relative_to(output.parent), "Keep the private backup outside the public evidence directory")
    return output, backup


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def private_write(path, content):
    with path.open("xb") as file:
        os.chmod(path, 0o600)
        file.write(content)


class Fixture:
    def __init__(self, args):
        self.args = args
        self.owner = "vu-" + secrets.token_hex(8)
        self.label = "io.vectory.manager-upgrade"
        self.trial = Path(tempfile.mkdtemp(prefix="vectory-manager-upgrade-"))
        os.chmod(self.trial, 0o700)
        self.containers, self.volumes, self.networks = [], [], []
        self.http = f"http://127.0.0.1:{port()}"
        self.https = f"https://127.0.0.1:{port()}"
        self.cookies = http.cookiejar.CookieJar()
        self.web = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))
        self.csrf = None
        self.old_image = None
        self.server = None
        self.environment = []

    def docker(self, *args, timeout=60):
        return command(["docker", *map(str, args)], timeout)

    def owned(self, kind, name):
        inspected = json.loads(self.docker(kind, "inspect", name))[0]
        labels = inspected.get("Labels") if kind in ("volume", "network") else inspected["Config"].get("Labels")
        require((labels or {}).get(self.label) == self.owner, "Refusing to change an unowned Docker resource")
        return inspected

    def volume(self, role):
        name = f"{self.owner}-{role}"
        self.volumes.append(name)
        self.docker("volume", "create", "--label", f"{self.label}={self.owner}", name)
        return name

    def run(self, role, image, arguments, detached=False):
        name = f"{self.owner}-{role}"
        self.containers.append(name)
        common = ["run", "--name", name, "--label", f"{self.label}={self.owner}", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "512m", "--cpus", "1", "--pids-limit", "64"]
        if detached:
            common.append("--detach")
        else:
            common.append("--rm")
        self.docker(*common, *arguments, image, timeout=180)
        return name

    def pki_helper(self, role, executable, arguments=()):
        # Fresh named volume inherits /var/lib/vectory's image-owned UID.
        name = f"{self.owner}-{role}"
        self.containers.append(name)
        return self.docker("run", "--rm", "--name", name, "--label", f"{self.label}={self.owner}", "--network", "none", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "256m", "--cpus", "1", "--pids-limit", "64", "--mount", f"type=volume,src={self.pki},dst=/var/lib/vectory", "--entrypoint", executable, self.old_image, *arguments)

    def request(self, route, method="GET", payload=None, agent=False, expected=(200, 201)):
        origin = self.https if agent else self.http
        headers = {} if agent else {"Origin": self.http}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if not agent and method != "GET" and self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = urllib.request.Request(origin + route, data=None if payload is None else json.dumps(payload).encode(), method=method, headers=headers)
        opener = self.device if agent and hasattr(self, "device") else self.agent if agent else self.web
        try:
            response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.status in expected, f"Unexpected HTTP {response.status} during {method} {route}")
            raw = response.read(2 << 20)
            require(len(raw) < 2 << 20, "Fixture HTTP body exceeded its bound")
            return json.loads(raw)

    def start(self, image, role):
        arguments = ["--network", "host", "--user", "10001:10001", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001", "--mount", f"type=volume,src={self.data},dst=/var/lib/vectory", "--mount", f"type=volume,src={self.pki},dst=/run/fixture,readonly"]
        for setting in self.environment:
            arguments += ["--env", setting]
        self.server = self.run(role, image, arguments, detached=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                return self.request("/api/v1/status")
            except (OSError, RuntimeError):
                time.sleep(0.5)
        raise RuntimeError("The owned manager did not become ready within 90 seconds")

    def key_hashes(self):
        script = "import hashlib,json; from pathlib import Path; p=Path('/var/lib/vectory/keys'); print(json.dumps({str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() for f in p.rglob('*') if f.is_file()},sort_keys=True))"
        return json.loads(self.docker("exec", self.server, "python3", "-c", script))

    def heartbeat(self):
        nonce = base64.b64encode(secrets.token_bytes(32)).decode()
        envelope = self.request("/agent/v1/heartbeat", "POST", {"protocol_version": 1, "request_id": secrets.token_hex(16), "nonce": nonce, "boot_id": "synthetic-manager-upgrade", "agent_version": "synthetic-upgrade-client", "vector_version": "0.58.0", "reported_generation": 0, "policy_generation": 0, "actual_sha256": "", "apply_state": "unmanaged", "local_paused": False, "remote_pause_acknowledged": False}, agent=True)
        payload, signature = base64.b64decode(envelope["payload"], validate=True), base64.b64decode(envelope["signature"], validate=True)
        (self.trial / "manifest.payload").write_bytes(payload)
        (self.trial / "manifest.signature").write_bytes(signature)
        command(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(self.trial / "signing.pem"), "-rawin", "-in", str(self.trial / "manifest.payload"), "-sigfile", str(self.trial / "manifest.signature")], timeout=15)
        manifest = json.loads(payload)
        require(manifest["nonce"] == nonce and manifest["device_id"] == self.credentials["device_id"], "Manifest is not bound to the original identity and fresh nonce")
        return manifest

    def qualify(self):
        info = json.loads(self.docker("info", "--format", '{{json .OSType}}'))
        require(info == "linux", "This qualification requires a Linux Docker engine")
        identities = {}
        # Pin actual current images before loading the historical archive,
        # whose original Docker-save tag is also vectory-server:candidate.
        for key, image in (("candidate", self.args.candidate_image), ("validator", self.args.validator_image)):
            inspected = json.loads(self.docker("image", "inspect", image))[0]
            require(inspected["Config"].get("Labels", {}).get("org.opencontainers.image.source") == SOURCE, "Image source is not the Vectory repository")
            identities[key] = inspected["Id"]
        prior_tag = subprocess.run(["docker", "image", "inspect", "vectory-server:candidate"], capture_output=True, timeout=15)
        require(prior_tag.returncode == 0 or missing_resource(prior_tag), "Cannot verify the preexisting candidate tag")
        prior_tag_id = json.loads(prior_tag.stdout)[0]["Id"] if prior_tag.returncode == 0 else None
        baseline = baseline_archive(self.args.baseline_archive, self.trial)
        baseline_ids = archive_image_ids(baseline)
        try:
            self.docker("load", "--input", baseline, timeout=180)
            inspected = json.loads(self.docker("image", "inspect", "vectory-server:candidate"))[0]
            require(inspected["Id"] in baseline_ids, "Loaded baseline image does not match the published configuration/OCI identity")
            require(inspected["Config"].get("Labels", {}).get("org.opencontainers.image.source") == SOURCE, "Baseline image source differs")
            identities["baseline"] = self.old_image = inspected["Id"]
        finally:
            if prior_tag_id:
                current = json.loads(self.docker("image", "inspect", "vectory-server:candidate"))[0]["Id"]
                require(current == prior_tag_id or current in baseline_ids, "Candidate tag changed concurrently; refusing to overwrite it")
                self.docker("tag", prior_tag_id, "vectory-server:candidate")
        self.args.candidate_image = identities["candidate"]
        self.args.validator_image = identities["validator"]
        self.data, self.pki = self.volume("data"), self.volume("pki")
        self.pki_helper("certificates", "/app/operations/vectory-local-pki", ("--out", "/var/lib/vectory/pki", "--hosts", "localhost,127.0.0.1", "--days", "7", "--bootstrap", "/var/lib/vectory/bootstrap"))
        self.pki_helper("chain", "python3", ("-c", "from pathlib import Path; p=Path('/var/lib/vectory/pki'); f=p/'agent-chain.pem'; f.write_bytes((p/'server.pem').read_bytes()+(p/'ca.pem').read_bytes()); f.chmod(0o600)"))
        ca = self.pki_helper("read-ca", "cat", ("/var/lib/vectory/pki/ca.pem",))
        bootstrap = self.pki_helper("read-bootstrap", "cat", ("/var/lib/vectory/bootstrap",)).decode().strip()
        private_write(self.trial / "ca.pem", ca)
        context = ssl.create_default_context(cafile=self.trial / "ca.pem")
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        self.agent = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        network = self.owner + "-validation"
        self.networks.append(network)
        self.docker("network", "create", "--internal", "--label", f"{self.label}={self.owner}", network)
        worker = self.run("validator", self.args.validator_image, ["--network", network, "--user", "10002:10002", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m,uid=10002,gid=10002", "--env", "VECTORY_VALIDATOR_ISOLATED=true"], detached=True)
        worker_info = self.owned("container", worker)
        require(not worker_info["HostConfig"]["PortBindings"], "Validator has a published port")
        worker_ip = worker_info["NetworkSettings"]["Networks"][network]["IPAddress"]
        self.environment = ["VECTORY_DEVELOPMENT=true", "VECTORY_COOKIE_SECURE=false", f"VECTORY_HTTP_ADDR=127.0.0.1:{urllib.parse.urlsplit(self.http).port}", f"VECTORY_AGENT_ADDR=127.0.0.1:{urllib.parse.urlsplit(self.https).port}", f"VECTORY_PUBLIC_URL={self.http}", f"VECTORY_PUBLIC_AGENT_URL={self.https}", "VECTORY_TLS_CERT=/run/fixture/pki/agent-chain.pem", "VECTORY_TLS_KEY=/run/fixture/pki/server-key.pem", "VECTORY_BOOTSTRAP_SECRET_FILE=/run/fixture/bootstrap", f"VECTORY_VALIDATION_URL=http://{worker_ip}:8081", f"NO_PROXY={worker_ip}", f"no_proxy={worker_ip}", "VECTORY_INSTANCE_NAME=Synthetic manager upgrade qualification"]
        status = self.start(self.old_image, "old-manager")
        require(status["version"] == "0.1.1" and not status["initialized"], "Baseline manager version or initialization differs")
        login = {"email": "synthetic-upgrade@example.invalid", "password": secrets.token_urlsafe(32)}
        initial = self.request("/api/v1/bootstrap", "POST", {**login, "name": "Synthetic upgrade administrator", "bootstrap_secret": bootstrap})
        self.csrf = initial["csrf_token"]
        user = initial["user"]["id"]
        config = {"sources": {"demo": {"type": "demo_logs", "format": "json"}}, "sinks": {"discard": {"type": "blackhole", "inputs": ["demo"]}}}
        pipeline = self.request("/api/v1/configurations", "POST", {"name": "Synthetic upgrade pipeline", "description": "CI fixture only; no events are activated", "graph": {"nodes": [], "edges": []}, "config": config})
        check = self.request(f"/api/v1/configurations/{pipeline['id']}/validate", "POST", {"config": config})
        require(check["valid"] and check["vector_validated"] and not check["deferred"], "Baseline pipeline did not pass actual Vector validation")
        version = self.request(f"/api/v1/configurations/{pipeline['id']}/publish", "POST", {"revision": pipeline["revision"], "message": "Synthetic upgrade qualification"})
        token = self.request("/api/v1/tokens", "POST", {"name": "Synthetic upgrade token", "expires_hours": 1, "max_uses": 1, "device_name": "synthetic-manager-upgrade"})
        command(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(self.trial / "device.key")], timeout=15)
        os.chmod(self.trial / "device.key", 0o600)
        command(["openssl", "req", "-new", "-key", str(self.trial / "device.key"), "-subj", "/CN=synthetic-upgrade-client", "-out", str(self.trial / "device.csr")], timeout=15)
        self.credentials = self.request("/agent/v1/enroll", "POST", {"protocol_version": 1, "request_id": secrets.token_hex(16), "token": token["token"], "name": "synthetic-manager-upgrade", "csr_pem": (self.trial / "device.csr").read_text(), "os": "linux", "arch": "amd64", "agent_version": "synthetic-upgrade-client", "vector_version": "0.58.0", "configuration_mode": "full"}, agent=True)
        private_write(self.trial / "device.pem", self.credentials["certificate_pem"].encode())
        context.load_cert_chain(self.trial / "device.pem", self.trial / "device.key")
        self.device = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        public = base64.b64decode(self.credentials["signing_public_key"], validate=True)
        require(len(public) == 32, "Unexpected signing public key")
        spki = bytes.fromhex("302a300506032b6570032100") + public
        private_write(self.trial / "signing.pem", b"-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(spki) + b"\n-----END PUBLIC KEY-----\n")
        deployment = self.request("/api/v1/deployments", "POST", {"version_id": version["id"], "priority": 1, "target_mode": "snapshot", "selector": {"device_ids": [self.credentials["device_id"]], "group_ids": [], "exclude_ids": []}, "rollout": {"kind": "all", "canary_size": 1, "batch_size": 10, "observation_seconds": 0, "failure_threshold": 0}})
        before = self.heartbeat()
        require(before["desired"]["version_id"] == version["id"], "Baseline assignment did not reach the authenticated protocol client")
        keys_before = self.key_hashes()
        self.docker("exec", self.server, "python3", "/app/operations/backup.py", "backup", "--state", "/var/lib/vectory", "--out", "/tmp/upgrade-backup", timeout=90)
        self.docker("cp", f"{self.server}:/tmp/upgrade-backup", self.args.private_backup_dir, timeout=90)
        backup = self.args.private_backup_dir
        os.chmod(backup, 0o700)
        backup_manifest = json.loads((backup / "manifest.json").read_text())
        for name, checksum in backup_manifest["files"].items():
            require(Path(name).parts and not Path(name).is_absolute() and ".." not in Path(name).parts, "Unsafe backup manifest path")
            require(digest(backup / name) == checksum, "Backup file checksum changed")
        with sqlite3.connect((backup / "vectory.db").as_uri() + "?mode=ro", uri=True) as database:
            require(database.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "Backup integrity check failed")
            require(not database.execute("PRAGMA foreign_key_check").fetchall(), "Backup foreign key check failed")
        self.owned("container", self.server)
        self.docker("stop", "--time", "20", self.server, timeout=30)
        self.docker("rm", self.server)
        status = self.start(self.args.candidate_image, "new-manager")
        require(status["version"] == self.args.candidate_version and status["initialized"], "Candidate manager did not preserve initialization")
        retained_session = self.request("/api/v1/session")
        require(retained_session["user"]["id"] == user, "Existing administrator/session changed")
        renewed = self.request("/api/v1/login", "POST", login)
        require(renewed["user"]["id"] == user, "Administrator cannot log in after upgrade")
        self.csrf = renewed["csrf_token"]
        retained_pipeline = self.request(f"/api/v1/configurations/{pipeline['id']}")
        require(retained_pipeline["config"] == config and retained_pipeline["revision"] == pipeline["revision"], "Draft content or revision changed")
        retained_version = self.request(f"/api/v1/versions/{version['id']}")
        require(retained_version["sha256"] == version["sha256"], "Published immutable artifact changed")
        after = self.heartbeat()
        require(after["desired"] == before["desired"] and after["policy_generation"] == before["policy_generation"], "Assignment identity or generation changed")
        require(self.key_hashes() == keys_before, "Durable CA, signing or sealing keys changed")
        identity = self.request("/agent/v1/identity", agent=True)
        require(identity["device_id"] == self.credentials["device_id"], "Original mTLS credential lost authorization")
        final_check = self.request(f"/api/v1/configurations/{pipeline['id']}/validate", "POST", {"config": config})
        require(final_check["valid"] and final_check["vector_validated"] and not final_check["deferred"], "Candidate pipeline did not pass actual Vector validation")
        return {"baseline_version": "0.1.1", "candidate_version": self.args.candidate_version, "baseline_archive_sha256": BASELINE_SHA, "images": identities, "synthetic": True, "administrator_and_session_retained": True, "draft_and_published_artifact_retained": True, "desired_and_policy_generation_retained": True, "durable_keys_sha256": keys_before, "original_mtls_identity_authorized": True, "manifest_signature_verified_with_original_key": True, "native_vector_validation_before_and_after": True, "backup_inventory_and_sqlite_verified": True, "backup_manifest_sha256": digest(backup / "manifest.json"), "device_id": self.credentials["device_id"], "pipeline_id": pipeline["id"], "version_id": version["id"], "deployment_id": deployment["id"], "host_service_installed": False, "vector_activation_attempted": False}

    def cleanup(self):
        failures = []
        for kind, names in (("container", self.containers), ("network", self.networks), ("volume", self.volumes)):
            for name in reversed(names):
                try:
                    exists = subprocess.run(["docker", kind, "inspect", name], capture_output=True, timeout=15)
                    if exists.returncode:
                        if missing_resource(exists):
                            continue
                        raise RuntimeError("Cannot verify whether an owned resource remains")
                    self.owned(kind, name)
                    self.docker(kind, "rm", *( ["--force"] if kind == "container" else [] ), name, timeout=30)
                except Exception:
                    failures.append(kind)
        # Only this newly created temporary tree is removed. A private backup
        # outside it remains for the operator, never in uploaded public evidence.
        if self.trial.resolve().parent == Path(tempfile.gettempdir()).resolve() and self.trial.name.startswith("vectory-manager-upgrade-") and not self.trial.is_symlink():
            shutil.rmtree(self.trial)
        else:
            failures.append("temporary directory")
        require(not failures, "Owned upgrade resources could not all be removed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--validator-image", required=True)
    parser.add_argument("--candidate-version", default="0.2.0")
    parser.add_argument("--baseline-archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--private-backup-dir", type=Path, required=True)
    args = parser.parse_args()
    require(args.run and sys.platform == "linux", "Use --run on an isolated Linux Docker host")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.candidate_version), "Candidate version must be a release version")
    require(all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,250}", image) for image in (args.candidate_image, args.validator_image)), "Image references are invalid")
    require(shutil.which("docker") and shutil.which("openssl"), "This maintainer fixture requires Docker and OpenSSL")
    args.output, args.private_backup_dir = evidence_destinations(args.output, args.private_backup_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.private_backup_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fixture = Fixture(args)
    report = {"result": "failed", "scope": "Actual manager upgrade and original authenticated protocol client; synthetic fixture, no host service or Vector activation"}
    try:
        report.update(fixture.qualify())
        report["result"] = "passed"
    except Exception as error:
        report["error_class"] = type(error).__name__
        # Fixed harness errors are safe; underlying command/HTTP response text
        # and subprocess stderr are deliberately omitted from public receipts.
        if isinstance(error, RuntimeError):
            report["error"] = str(error)
        raise
    finally:
        try:
            fixture.cleanup()
            report["owned_fixture_resources_removed"] = True
        except Exception:
            report["result"] = "failed"
            report["owned_fixture_resources_removed"] = False
            raise
        finally:
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    print("PASS: published 0.1.1 manager upgraded, original mTLS/signing identity and state retained, private backup verified. No host service or Vector activation.")


if __name__ == "__main__":
    main()
