"""Independent Windows maintenance proof, using only newly-created synthetic state.

Never enrolls, runs a daemon/workload, registers a service, or reads existing state.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
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
    names = ["agent/cmd/vectory/main.go", "agent/internal/agent/reconcile.go",
             "agent/internal/agent/recovery.go", "agent/internal/agent/secrets.go",
             "agent/internal/agent/telemetry.go", "agent/internal/agent/storage.go",
             "agent/internal/agent/types.go", "agent/internal/agent/platform_windows.go",
             "agent/internal/agent/platform_unix.go", "agent/internal/agent/settings_update.go"]
    paths = [ROOT / name for name in names]
    paths += list((ROOT / "agent/internal/agent").glob("readoption*.go"))
    return {path.relative_to(ROOT).as_posix(): sha(path) for path in sorted(paths)}


@contextmanager
def deny_delete(path: Path):
    """Allow reading/writing the existing file, but deny replacement via sharing."""
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert os.name == "nt", "This harness qualifies Windows only"
    agent, output = args.agent.resolve(), args.output.resolve()
    assert output.is_relative_to(ROOT / ".local")
    assert output.name.startswith("settings-update-access-"), "Use this slice's new bounded output namespace"
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / ("fixture-" + str(uuid.uuid4()))
    binary_dir, state_dir, managed_dir = fixture / "bin", fixture / "state", fixture / "managed"
    binary_dir.mkdir(parents=True)
    managed_dir.mkdir()
    binary, managed = binary_dir / "vector.exe", managed_dir / "managed.json"
    shutil.copyfile(args.vector, binary)
    managed.write_text('{"sources":{"fixture":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["fixture"]}}}\n', encoding="utf-8")
    commands, groups = [], []
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "passed": False,
              "scope": "Independent Windows CLI on newly-created synthetic local state. No server, real credentials, enrollment, daemon, workload, services, or global trust changes.",
              "agent": {"path": str(agent), "sha256": sha(agent)},
              "vector": {"path": str(args.vector), "sha256": sha(args.vector)},
              "commands": commands, "groups": groups, "harness": {"path": str(Path(__file__).resolve()), "sha256": sha(Path(__file__))},
              "harness_sha256": sha(Path(__file__)),
              "source_sha256": source_snapshot(), "fixture_path": str(fixture), "fixture_removed": False}

    def call(*arguments):
        started = time.monotonic()
        result = subprocess.run([str(agent), *map(str, arguments)], capture_output=True, text=True,
                                timeout=35, creationflags=subprocess.CREATE_NO_WINDOW)
        commands.append({"arguments": [str(arg).replace(str(fixture), "<private-fixture>") for arg in arguments],
                         "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - started, 3),
                         "stdout": result.stdout.strip(), "stderr": result.stderr.strip()})
        return result

    def success(*arguments):
        result = call(*arguments)
        assert result.returncode == 0, result.stdout + result.stderr
        return result

    def read(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def write(path, value):
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def snapshot():
        return {p.relative_to(fixture).as_posix(): sha(p) for p in sorted(fixture.rglob("*"))
                if p.is_file() and p.name != "agent.lock" and not p.is_relative_to(binary_dir)}

    def dacl(path, add=False):
        assert path.resolve().is_relative_to(fixture.resolve())
        if add:
            changed = subprocess.run(["icacls", str(path), "/grant", "*S-1-5-32-544:(R)"],
                                     capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
            assert changed.returncode == 0, changed.stderr
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
            if rendered:
                kernel.LocalFree(rendered)
            kernel.LocalFree(descriptor)

    def access():
        return {path.relative_to(fixture).as_posix(): {"owner_group_dacl": dacl(path), "mandatory_label": label(path)}
                for path in [state_dir, state_dir / "settings.json", state_dir / "state.json", state_dir / "agent.lock"]}

    def check_access():
        assert access() == expected_access, "An existing directory/settings/state/lock descriptor changed"

    def preserved(before, allowed=()):
        after = snapshot()
        assert {p: h for p, h in before.items() if p not in allowed} == {p: h for p, h in after.items() if p not in allowed}, "Unrelated protected fixture bytes changed"
        check_access()

    def accept_group(name, before, allowed=(), **details):
        preserved(before, allowed)
        groups.append({"name": name, "passed": True, **details})

    def reject_unchanged(name, *arguments):
        before = snapshot()
        result = call(*arguments)
        assert result.returncode != 0, name + " unexpectedly succeeded"
        accept_group(name, before, rejected=True)
        return result

    try:
        success("install", "--state-dir", state_dir, "--vector-binary", binary, "--managed-config", managed, "--adopt")
        settings_path, state_path = state_dir / "settings.json", state_dir / "state.json"
        future = {"exact_counter": 18446744073709551615, "array": [None, False, 9007199254740993], "nested": {"enabled": True}}
        settings = read(settings_path)
        settings["future_extension"] = future
        settings["capability_policy"]["future_allowance"] = future
        write(settings_path, settings)
        initial_state = read(state_path)
        initial_state.update({"device_id": "27f920b5-9b23-42e8-a2e9-90eb684390d9", "highest_generation": 14,
                              "highest_policy_generation": 8, "reported_generation": 13, "accepted": True,
                              "apply_state": "failed", "failed_generation": 14, "failed_effective_sha256": "b" * 64,
                              "actual_sha256": "a" * 64, "last_good_sha256": "a" * 64, "secret_revision": 4,
                              "applied_secret_revision": 3, "future_state": future,
                              "policy": {"heartbeat_seconds": 90, "sync_paused": True, "telemetry_enabled": False},
                              "error": {"code": "VALIDATION_FAILED", "stage": "validation", "message": "Synthetic retained rejection"}})
        write(state_path, initial_state)
        (state_dir / "paused").write_bytes(b"Synthetic durable local pause\n")
        (state_dir / "fixture-identity.txt").write_bytes(b"Synthetic preservation marker, not a credential\n")
        (state_dir / ("good-" + "a" * 64 + ".json")).write_bytes(managed.read_bytes())
        for path in [state_dir, settings_path, state_path, state_dir / "agent.lock"]:
            dacl(path, True)
            label(path, True)
        expected_access = access()
        report["fixture_access"] = expected_access
        report["fixture_access_scope"] = "Current operator plus synthetic Administrators read ACE and explicit Medium NWNR label; no actual SCM identity or privilege enabling."
        base = ("install", "--state-dir", state_dir)
        before = snapshot()
        success(*base)
        accept_group("Existing install is an exact no-op, including directory and lock access", before)

        # Inherit the already protected state-directory descriptor, without touching a real secret.
        secret = state_dir / "synthetic-secret.txt"
        secret.write_text("synthetic-private-fixture-value\n", encoding="utf-8")
        # Validation permits the current owner, SYSTEM and Administrators. These are fixture-only rights.
        binding_path = fixture / "bindings.json"
        write(binding_path, {"FIXTURE_TOKEN": str(secret)})
        before = snapshot()
        success("configure-secrets", "--state-dir", state_dir, "--secret-files", binding_path)
        current = read(settings_path)
        assert current["secret_files"] == {"FIXTURE_TOKEN": str(secret)}
        assert current["future_extension"] == future and current["capability_policy"]["future_allowance"] == future
        assert read(state_path) == initial_state
        accept_group("Changed secret bindings preserve unrelated raw settings and exact state", before, ("state/settings.json",))
        before = snapshot()
        success("configure-secrets", "--state-dir", state_dir, "--secret-files", binding_path)
        accept_group("Identical secret bindings preserve exact settings bytes", before)
        write(binding_path, {})
        before = snapshot()
        success("configure-secrets", "--state-dir", state_dir, "--secret-files", binding_path)
        assert "secret_files" not in read(settings_path)
        accept_group("Empty binding map deliberately removes bindings without state reset", before, ("state/settings.json",))

        before = snapshot()
        success(*base, "--metrics-url", "http://127.0.0.1:19999/metrics")
        assert read(settings_path)["metrics_url"] == "http://127.0.0.1:19999/metrics"
        accept_group("Changed metrics endpoint preserves access and performs no enrollment or workload action", before, ("state/settings.json",))
        before = snapshot()
        success(*base, "--metrics-url", "http://127.0.0.1:19999/metrics")
        accept_group("Identical metrics endpoint is an exact no-op", before)
        reject_unchanged("Invalid metrics endpoint is refused before mutation", *base, "--metrics-url", "https://example.invalid/metrics")
        write(binding_path, {"invalid name": str(secret)})
        reject_unchanged("Invalid secret binding is refused before mutation", "configure-secrets", "--state-dir", state_dir, "--secret-files", binding_path)
        saved_settings = settings_path.read_bytes()
        settings_path.write_bytes(b"{invalid synthetic settings")
        reject_unchanged("Malformed settings are not reconstructed from typed defaults", *base, "--metrics-url", "http://127.0.0.1:19998/metrics")
        settings_path.write_bytes(saved_settings)

        policy_path = fixture / "allowances.json"
        write(policy_path, {"allowed_file_roots": [str(fixture / "allowed-data")], "allowed_network_hosts": ["127.0.0.1:19999"], "allowed_listen_addresses": []})
        before = snapshot()
        success(*base, "--capability-policy", policy_path)
        expected_state = {k: v for k, v in initial_state.items() if k not in ("failed_generation", "failed_effective_sha256")}
        assert read(state_path) == expected_state
        current = read(settings_path)
        assert current["capability_policy"]["future_allowance"] == future
        assert current["capability_policy"]["allowed_network_hosts"] == ["127.0.0.1:19999"]
        accept_group("Changed local allowances clear only suppression and retain raw state extensions", before, ("state/settings.json", "state/state.json"))
        write(state_path, initial_state)
        before = snapshot()
        success(*base, "--capability-policy", policy_path)
        accept_group("Identical allowances do not clear a newly suppressed failure", before)

        before = snapshot()
        success(*base, "--allow-full-vector-config")
        assert read(settings_path)["capability_policy"]["full_vector_config"] is True
        assert read(state_path) == expected_state
        accept_group("Explicit full mode changes settings and only resets suppression", before, ("state/settings.json", "state/state.json"))
        write(state_path, initial_state)
        before = snapshot()
        success(*base, "--allow-full-vector-config")
        accept_group("Repeated mode preserves exact settings and later failure suppression", before)

        import msvcrt
        with (state_dir / "agent.lock").open("r+b") as held:
            held.seek(0)
            msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                reject_unchanged("Held operation lock refuses settings mutation and retains lock access", *base, "--allow-full-vector-config=false")
            finally:
                held.seek(0)
                msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)

        saved_state = state_path.read_bytes()
        state_path.write_bytes(b"{invalid synthetic state")
        reject_unchanged("Malformed state preflight cannot save a new mode or clear suppression", *base, "--allow-full-vector-config=false")
        state_path.write_bytes(saved_state)
        with deny_delete(settings_path):
            reject_unchanged("Blocked settings replacement leaves both settings and suppression unchanged", *base, "--allow-full-vector-config=false")

        before = snapshot()
        with deny_delete(state_path):
            result = call(*base, "--allow-full-vector-config=false")
        assert result.returncode != 0
        assert "settings were saved" in result.stderr and "retry-suppression reset is incomplete" in result.stderr, result.stderr
        assert not read(settings_path)["capability_policy"].get("full_vector_config", False)
        assert state_path.read_bytes() == saved_state
        accept_group("Late state replacement refusal reports the saved setting and incomplete suppression reset", before, ("state/settings.json",), partial_completion=True)
        before = snapshot()
        success("retry", "--state-dir", state_dir)
        assert read(state_path) == expected_state
        accept_group("Explicit retry finishes the reset while preserving state access and unrelated raw content", before, ("state/state.json",))
        before = snapshot()
        success("retry", "--state-dir", state_dir)
        accept_group("Repeated explicit retry is an exact byte no-op", before)

        current = read(settings_path)
        assert current["future_extension"] == future and current["capability_policy"]["future_allowance"] == future
        # Separate expected observation: a CLI invocation combines sequential operations.
        # It is deliberately excluded from the correctness groups/command list above.
        write(state_path, initial_state)
        before = snapshot()
        result = call(*base, "--allow-full-vector-config", "--metrics-url", "https://example.invalid/metrics")
        observation_command = commands.pop()
        assert result.returncode != 0
        assert read(settings_path)["capability_policy"]["full_vector_config"] is True
        assert read(state_path) == expected_state
        preserved(before, ("state/settings.json", "state/state.json"))
        report["separate_expected_observation"] = "combined-options-observation.json"
        observation = {"recorded_at": datetime.now(timezone.utc).isoformat(), "status": "confirmed_sequential_partial_completion",
                       "classification": "Separate expected workflow observation; excluded from correctness acceptance counts.",
                       "candidate": report["agent"], "harness_sha256": report["harness_sha256"],
                       "command": observation_command, "observed": {"overall_command_failed": True,
                       "new_full_mode_saved": True, "retry_suppression_cleared": True,
                       "invalid_metrics_rejected": True, "prior_metrics_retained": read(settings_path)["metrics_url"],
                       "unrelated_bytes_and_tested_access_preserved": True},
                       "limits": "Synthetic stopped CLI only; no workload, service or real identity. This is documented sequential behavior, not a claim of transaction atomicity."}
        (output / "combined-options-observation.json").write_text(json.dumps(observation, indent=2) + "\n", encoding="utf-8")
        report["source_end_sha256"] = source_snapshot()
        assert report["source_sha256"] == report["source_end_sha256"], "Source changed during native run"
        report["passed"] = True
        report["counts"] = {"groups": len(groups), "commands": len(commands)}
        report["limits"] = ["State fields are seeded preservation evidence, not activation or real enrollment.",
                            "No real service identity, SCM process, reboot, audit SACL, central policy or Unix runtime qualification.",
                            "Settings and suppression reset are separate commits; the deliberate late-state failure demonstrates partial completion.",
                            "Enrollment preparation and unenrollment writer coverage belongs to owner tests, not this CLI execution."]
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
