"""Independent private CLI qualification; never starts an agent or Vector workload."""
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
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_snapshot() -> dict[str, str]:
    paths = [ROOT / name for name in ["agent/cmd/vectory/main.go", "agent/internal/agent/reconcile.go", "agent/internal/agent/vector.go", "agent/internal/agent/storage.go", "agent/internal/agent/types.go", "agent/internal/agent/diagnostics.go"]]
    paths += list((ROOT / "agent/internal/agent").glob("readoption*.go"))
    paths += [ROOT / "agent/internal/agent/platform_windows.go", ROOT / "agent/internal/agent/platform_unix.go"]
    return {path.relative_to(ROOT).as_posix(): sha(path) for path in sorted(paths)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    agent, upstream, output = args.agent.resolve(), args.vector.resolve(), args.output.resolve()
    assert output.is_relative_to(ROOT / ".local"), "Use a new workspace-local evidence directory"
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / ("fixture-" + str(uuid.uuid4()))
    binary_dir, state_dir, managed_dir = fixture / "bin", fixture / "state", fixture / "managed"
    binary_dir.mkdir(parents=True)
    managed_dir.mkdir()
    binary, managed = binary_dir / "vector.exe", managed_dir / "managed.json"
    shutil.copyfile(upstream, binary)
    data_dir = fixture / "vector-data"
    data_dir.mkdir()
    policy_path = fixture / "capability-policy.json"
    policy_path.write_text(json.dumps({"allowed_file_roots": [str(data_dir)]}), encoding="utf-8")
    configuration = json.dumps({"data_dir": str(data_dir), "sources": {"synthetic": {"type": "demo_logs", "format": "json"}}, "sinks": {"discard": {"type": "blackhole", "inputs": ["synthetic"]}}}).encode()
    managed.write_bytes(configuration)
    commands: list[dict] = []
    groups: list[dict] = []
    report: dict = {
        "recorded_at": datetime.now(timezone.utc).isoformat(), "passed": False,
        "scope": "Independent Windows CLI on private synthetic state and a copied native Vector0.58.0 with inert PE overlay. No server, real credentials, daemon, services, network requests or workload activation.",
        "agent": {"path": str(agent), "sha256": sha(agent)},
        "original_vector_sha256": sha(upstream),
        "commands": commands, "groups": groups,
        "harness_sha256": sha(Path(__file__)),
        "source_sha256": source_snapshot(),
        "fixture_path": str(fixture), "fixture_removed": False,
    }

    def call(*arguments: object) -> subprocess.CompletedProcess:
        started = time.monotonic()
        result = subprocess.run([str(agent), *map(str, arguments)], capture_output=True, text=True, timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        commands.append({"arguments": [str(arg).replace(str(fixture), "<private-fixture>") for arg in arguments], "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - started, 3), "stdout": result.stdout.strip(), "stderr": result.stderr.strip()})
        return result

    def snapshot() -> dict[str, str]:
        return {p.relative_to(fixture).as_posix(): sha(p) for p in sorted(fixture.rglob("*")) if p.is_file() and p.name != "agent.lock" and not p.is_relative_to(binary_dir)}

    def settings_security(path: Path, add_fixture_rule: bool = False) -> str:
        assert path.resolve().is_relative_to(fixture.resolve())
        if os.name != "nt":
            info = path.stat()
            return f"{info.st_uid}:{info.st_gid}:{info.st_mode:o}"
        quoted = "'" + str(path).replace("'", "''") + "'"
        script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath " + quoted + "; "
        if add_fixture_rule:
            # Only this synthetic settings file gains a distinctive local ACE.
            # No real service account, protected state or global policy is changed.
            changed = subprocess.run(["icacls", str(path), "/grant", "*S-1-5-32-544:(R)"], capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            assert changed.returncode == 0, changed.stderr
        script += "$acl.Sddl"
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def mandatory_label(path: Path, set_fixture_label: bool = False) -> str:
        assert path.resolve().is_relative_to(fixture.resolve())
        if os.name != "nt":
            return "not_windows"
        import ctypes
        from ctypes import wintypes
        advapi, kernel = ctypes.WinDLL("advapi32", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
        pointer = ctypes.c_void_p
        advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
        advapi.GetSecurityDescriptorSacl.argtypes = [pointer, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(pointer), ctypes.POINTER(wintypes.BOOL)]
        advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, pointer, pointer, pointer, pointer]
        advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, pointer, pointer, pointer, ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
        advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [pointer, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
        kernel.LocalFree.argtypes = [pointer]
        label_flag = 0x10
        if set_fixture_label:
            descriptor = pointer()
            assert advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NWNR;;;ME)", 1, ctypes.byref(descriptor), None)
            try:
                present, defaulted, sacl = wintypes.BOOL(), wintypes.BOOL(), pointer()
                assert advapi.GetSecurityDescriptorSacl(descriptor, ctypes.byref(present), ctypes.byref(sacl), ctypes.byref(defaulted)) and present.value
                code = advapi.SetNamedSecurityInfoW(str(path), 1, label_flag, None, None, None, sacl)
                assert code == 0, f"Private fixture label setup failed: {code}"
            finally:
                kernel.LocalFree(descriptor)
        sacl, descriptor, rendered = pointer(), pointer(), pointer()
        code = advapi.GetNamedSecurityInfoW(str(path), 1, label_flag, None, None, None, ctypes.byref(sacl), ctypes.byref(descriptor))
        assert code == 0, f"Private fixture label read failed: {code}"
        try:
            assert advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, label_flag, ctypes.byref(rendered), None)
            return ctypes.wstring_at(rendered)
        finally:
            if rendered:
                kernel.LocalFree(rendered)
            kernel.LocalFree(descriptor)

    def reject_unchanged(label: str, *arguments: object) -> None:
        before = snapshot()
        result = call(*arguments)
        assert result.returncode != 0, (label, result.stdout)
        assert snapshot() == before, label + " changed protected fixture bytes"
        assert settings_security(state_dir / "agent.lock") == lock_security_before, label + " changed existing lock access"
        assert mandatory_label(state_dir / "agent.lock") == lock_label_before, label + " changed existing lock integrity label"
        groups.append({"name": label, "passed": True, "protected_bytes_unchanged": True})

    try:
        installed = call("install", "--state-dir", state_dir, "--vector-binary", binary, "--managed-config", managed, "--capability-policy", policy_path, "--adopt")
        assert installed.returncode == 0, installed.stderr
        settings_path, state_path = state_dir / "settings.json", state_dir / "state.json"
        security_before = settings_security(settings_path, add_fixture_rule=True)
        label_before = mandatory_label(settings_path, set_fixture_label=True)
        lock_security_before = settings_security(state_dir / "agent.lock", add_fixture_rule=True)
        lock_label_before = mandatory_label(state_dir / "agent.lock", set_fixture_label=True)
        original_settings = json.loads(settings_path.read_text(encoding="utf-8"))
        state = json.loads(state_path.read_text(encoding="utf-8"))
        good_digest = hashlib.sha256(configuration).hexdigest()
        state.update({"device_id": "ac770a2e-c65e-478f-b4e3-e59bd4f8f757", "highest_generation": 14, "highest_policy_generation": 8, "reported_generation": 13, "accepted": True, "apply_state": "failed", "actual_sha256": good_digest, "last_good_sha256": good_digest, "failed_generation": 14, "failed_effective_sha256": "a" * 64, "secret_revision": 4, "applied_secret_revision": 4, "error": {"code": "VALIDATION_FAILED", "stage": "validation", "message": "Synthetic preserved failure"}, "policy": {"heartbeat_seconds": 90, "sync_paused": True, "telemetry_enabled": False}})
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        good = state_dir / ("good-" + good_digest + ".json")
        good.write_bytes(configuration)

        (state_dir / "paused").write_bytes(b"Synthetic local maintenance pause\n")
        (state_dir / "fixture-identity.txt").write_bytes(b"Synthetic preservation marker; not a credential.\n")
        with binary.open("ab") as handle:
            handle.write(b"\nVectory independent synthetic same-version replacement\n")
        expected = sha(binary)
        report["replacement_vector_sha256"] = expected
        base = ("re-adopt", "--state-dir", state_dir, "--expected-sha256", expected.upper())

        preserved_state = state_path.read_bytes()
        state_path.write_bytes(b"{invalid fixture state")
        reject_unchanged("Unreadable durable state is never reset", *base)
        state_path.write_bytes(preserved_state)

        reject_unchanged("Wrong expected digest refuses before adopting", "re-adopt", "--state-dir", state_dir, "--expected-sha256", "0" * 64)

        if os.name == "nt":
            import msvcrt
            with (state_dir / "agent.lock").open("r+b") as held:
                held.seek(0)
                msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
                try:
                    reject_unchanged("Existing state lock prevents re-adoption", *base)
                finally:
                    held.seek(0)
                    msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)

        journal = state_dir / "journal.json"
        journal.write_text("{}\n", encoding="utf-8")
        reject_unchanged("Pending recovery journal remains untouched", *base)
        journal.unlink()

        managed.write_bytes(b"{invalid fixture JSON")
        reject_unchanged("Invalid managed configuration preserves prior pin", *base)
        managed.write_bytes(configuration)

        good.write_bytes(b"{}")
        reject_unchanged("Corrupted recorded last-good content preserves prior pin", *base)
        good.write_bytes(configuration)

        before = snapshot()
        success = call(*base, "--json")
        assert success.returncode == 0, success.stdout + success.stderr
        current = json.loads(settings_path.read_text(encoding="utf-8"))
        assert current == {**original_settings, "vector_binary_sha256": expected}
        after = snapshot()
        assert {p: h for p, h in after.items() if p != "state/settings.json"} == {p: h for p, h in before.items() if p != "state/settings.json"}
        assert json.loads(state_path.read_text(encoding="utf-8")) == state
        assert settings_security(settings_path) == security_before, "Settings owner/group/DACL changed"
        assert mandatory_label(settings_path) == label_before, "Settings mandatory integrity label changed"
        assert settings_security(state_dir / "agent.lock") == lock_security_before, "Existing lock owner/group/DACL changed"
        assert mandatory_label(state_dir / "agent.lock") == lock_label_before, "Existing lock mandatory label changed"
        groups.append({"name": "Approved same-path replacement changes only binary digest", "passed": True, "uppercase_input_normalized": True, "seeded_historical_state_only": True, "actual_activation": False, "preserved": ["state bytes", "generation and secret counters", "failed suppression and error", "local and remote pause", "managed and last-good bytes", "identity marker", "all other settings"]})
        report["settings_owner_group_dacl_preserved"] = True
        report["mandatory_integrity_label_preserved"] = {"label": label_before, "no_privilege_enabled": True, "fixture_only": True}
        report["existing_lock_access_preserved"] = {"owner_group_dacl": True, "mandatory_label": lock_label_before}

        before = snapshot()
        repeated = call(*base)
        assert repeated.returncode == 0, repeated.stdout + repeated.stderr
        assert snapshot() == before
        groups.append({"name": "Repeated approval preserves exact installed bytes", "passed": True})

        doctor = call("doctor", "--state-dir", state_dir, "--json")
        assert doctor.returncode == 0, doctor.stdout + doctor.stderr
        assert json.loads(doctor.stdout)["binary_integrity"] is True
        assert snapshot() == before
        groups.append({"name": "Doctor recognizes new pin without mutating state or claiming activation", "passed": True})

        report["source_end_sha256"] = source_snapshot()
        assert report["source_sha256"] == report["source_end_sha256"], "Source changed during qualification"
        report["passed"] = True
        report["counts"] = {"groups": len(groups), "commands": len(commands)}
        report["limits"] = ["Historical verification fields are intentionally seeded fixture state, not evidence of any prior or current workload activation.", "The PE overlay is a same-version synthetic replacement, not qualification of another upstream version.", "These checks do not prove native service/reboot behavior, power-loss durability, hostile concurrent path replacement or other platforms."]
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        if report["passed"]:
            assert fixture.resolve().parent == output and fixture.name.startswith("fixture-")
            shutil.rmtree(fixture)
            report["fixture_removed"] = not fixture.exists()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "groups": len(groups), "report": str(output / "report.json")}))


if __name__ == "__main__":
    main()
