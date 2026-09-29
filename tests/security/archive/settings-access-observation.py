"""Expected observation: local settings updates may drop provisioned access ACEs."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    assert os.name == "nt", "This exact observation is Windows-only"
    agent, output = args.agent.resolve(), args.output.resolve()
    assert output.is_relative_to(ROOT / ".local")
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / ("fixture-" + str(uuid.uuid4()))
    binaries, state, managed_dir = fixture / "bin", fixture / "state", fixture / "managed"
    binaries.mkdir(parents=True)
    managed_dir.mkdir()
    vector, managed = binaries / "vector.exe", managed_dir / "managed.json"
    shutil.copyfile(ROOT / ".local/tools/vector-0.58.0/bin/vector.exe", vector)
    managed.write_text(json.dumps({"sources": {"synthetic": {"type": "demo_logs", "format": "json"}}, "sinks": {"discard": {"type": "blackhole", "inputs": ["synthetic"]}}}), encoding="utf-8")
    empty_bindings = fixture / "empty-synthetic-bindings.json"
    empty_bindings.write_text("{}\n", encoding="utf-8")
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "passed": False, "classification": "expected_defect_observation", "correctness_acceptance": False, "agent": {"path": str(agent), "sha256": sha(agent)}, "harness_sha256": sha(Path(__file__)), "commands": [], "fixture_removed": False}

    def call(*arguments: object) -> subprocess.CompletedProcess:
        result = subprocess.run([str(agent), *map(str, arguments)], capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        report["commands"].append({"arguments": [str(a).replace(str(fixture), "<private-fixture>") for a in arguments], "exit_code": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()})
        return result

    def descriptor(path: Path, add: bool = False) -> str:
        assert path.resolve().is_relative_to(fixture)
        quoted = "'" + str(path).replace("'", "''") + "'"
        script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath " + quoted + "; "
        if add:
            changed = subprocess.run(["icacls", str(path), "/grant", "*S-1-5-32-544:(R)"], capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
            assert changed.returncode == 0, changed.stderr
        script += "$acl.Sddl"
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    try:
        installed = call("install", "--state-dir", state, "--vector-binary", vector, "--managed-config", managed, "--adopt")
        assert installed.returncode == 0, installed.stderr
        settings = state / "settings.json"
        before_acl = descriptor(settings, add=True)
        assert ";;;BA)" in before_acl, before_acl
        before_bytes = settings.read_bytes()
        other_before = {p.name: sha(p) for p in [state / "state.json", state / "adoption-backup.json", managed]}
        updated = call("configure-secrets", "--state-dir", state, "--secret-files", empty_bindings)
        assert updated.returncode == 0, updated.stderr
        after_acl = descriptor(settings)
        assert before_acl != after_acl and ";;;BA)" not in after_acl, (before_acl, after_acl)
        assert settings.read_bytes() == before_bytes, "Expected a no-op content update"
        assert {p.name: sha(p) for p in [state / "state.json", state / "adoption-backup.json", managed]} == other_before
        report.update({"passed": True, "observation": "Successful no-op configure-secrets rewrote settings access descriptor and removed a deliberately provisioned fixture ACE while settings content stayed identical.", "before_sddl": before_acl, "after_sddl": after_acl, "settings_bytes_unchanged": True, "state_managed_backup_unchanged": True, "scope": "Private synthetic Windows file ACL only. Administrator-group Read ACE is a harmless proxy for an additional provisioned principal. No NT SERVICE account was touched; no service restart/access attempt or actual workload activation is claimed. Only install's local version probe ran; configure-secrets used an empty synthetic map and read no credentials.", "source_sha256": {p: sha(ROOT / p) for p in ["agent/internal/agent/secrets.go", "agent/internal/agent/storage.go", "agent/internal/agent/platform_windows.go", "agent/internal/agent/service_windows.go"]}, "limits": ["Applies only to the exact recorded private executable and no-op settings-update path; other configuration commands are source-supported follow-ups.", "Actual SCM lifecycle failure is inferred from lost access and the service grant source, not executed."]})
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        if report["passed"]:
            assert fixture.resolve().parent == output and fixture.name.startswith("fixture-")
            shutil.rmtree(fixture)
            report["fixture_removed"] = not fixture.exists()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "report": str(output / "report.json")}))


if __name__ == "__main__":
    main()
