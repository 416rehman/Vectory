"""Independent combined-install Windows proof, using only newly-created synthetic state.

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
             "agent/internal/agent/platform_unix.go", "agent/internal/agent/settings_update.go", "agent/internal/agent/install_options.go"]
    paths = [ROOT / name for name in names]
    paths += list((ROOT / "agent/internal/agent").glob("readoption*.go"))
    paths += list((ROOT / "agent/internal/agent").glob("install_options*.go"))
    paths += [ROOT / "agent/cmd/vectory/install_test.go", ROOT / "agent/internal/agent/settings_update_test.go"]
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
    assert output.name.startswith("install-options-access-"), "Use this slice's new bounded output namespace"
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
        future = {"exact_counter": 18446744073709551615, "list": [None, False, 9007199254740993]}
        settings = read(settings_path)
        settings["server"] = "https://synthetic-instance.invalid"
        settings["name"] = "synthetic-preserved-identity"
        settings["ca_file"] = str(fixture / "synthetic-unused-ca.pem")
        settings["future_extension"] = future
        settings["capability_policy"]["future_allowance"] = future
        settings["metrics_url"] = "http://127.0.0.1:19800/metrics"
        write(settings_path, settings)
        initial_state = read(state_path)
        initial_state.update({"device_id": "50b3ff78-8539-47b7-b509-2754db947422", "highest_generation": 24,
                              "highest_policy_generation": 18, "reported_generation": 23, "accepted": True,
                              "apply_state": "failed", "failed_generation": 24, "failed_effective_sha256": "b" * 64,
                              "actual_sha256": "a" * 64, "last_good_sha256": "a" * 64, "secret_revision": 14,
                              "applied_secret_revision": 13, "future_state": future,
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
        report["fixture_access_scope"] = "Maintenance operator plus synthetic Administrators read ACE and Medium NWNR labels; no SCM identity or privilege enabling."
        secret = state_dir / "synthetic-secret.txt"
        secret.write_text("synthetic-private-value\n", encoding="utf-8")
        bindings_path, policy_path = fixture / "bindings.json", fixture / "allowances.json"
        write(bindings_path, {"FIXTURE_TOKEN": str(secret)})
        policy = {"allowed_file_roots": [str(fixture / "allowed-data")],
                  "allowed_network_hosts": ["127.0.0.1:19801"], "allowed_listen_addresses": [],
                  "full_vector_config": True}
        write(policy_path, policy)
        base = ("install", "--state-dir", state_dir)
        combined = ("--allow-full-vector-config", "--capability-policy", policy_path,
                    "--metrics-url", "http://127.0.0.1:19801/metrics", "--secret-files", bindings_path)
        reject_unchanged("Invalid later metrics leaves mode, allowances, settings and suppression unchanged", *base,
                         "--allow-full-vector-config", "--capability-policy", policy_path,
                         "--metrics-url", "https://example.invalid/metrics", "--secret-files", bindings_path)
        for port in [0, 65536]:
            reject_unchanged("Out-of-range metrics port refuses all updates: " + str(port), *base,
                             "--allow-full-vector-config", "--metrics-url", "http://127.0.0.1:" + str(port) + "/metrics")
        write(bindings_path, {"invalid name": str(secret)})
        reject_unchanged("Invalid later binding refuses all otherwise valid combined options", *base, *combined)
        write(bindings_path, {"FIXTURE_TOKEN": str(secret)})
        policy_bytes = policy_path.read_bytes()
        policy_path.write_bytes(b"{invalid synthetic policy")
        reject_unchanged("Malformed policy input refuses the whole request", *base, *combined)
        policy_path.write_bytes(policy_bytes)
        for name, payload in [("null policy", b"null"), ("unknown policy option", json.dumps({**policy, "allowed_netwrok_hosts": []}).encode())]:
            policy_path.write_bytes(payload)
            reject_unchanged("Strict supplied input rejects " + name + " without touching stored unknown fields", *base, *combined)
        policy_path.write_bytes(policy_bytes)
        bindings_bytes = bindings_path.read_bytes()
        bindings_path.write_text('{"FIXTURE_TOKEN":' + json.dumps(str(secret)) + ',"FIXTURE_TOKEN":' + json.dumps(str(secret)) + '}', encoding="utf-8")
        reject_unchanged("Duplicate binding key refuses the complete request", *base, *combined)
        bindings_path.write_bytes(bindings_bytes)
        for flag in ["--metrics-url=", "--capability-policy=", "--secret-files="]:
            reject_unchanged("Explicit empty option is rejected rather than silently omitted: " + flag,
                             *base, "--allow-full-vector-config", flag)
        reject_unchanged("Unexpected positional argument cannot silently drop a supplied option", *base,
                         "unexpected", "--allow-full-vector-config")

        before = snapshot()
        success(*base, *combined)
        expected_state = {k: v for k, v in initial_state.items() if k not in ("failed_generation", "failed_effective_sha256")}
        current = read(settings_path)
        expected_settings = {**settings, "capability_policy": {**settings["capability_policy"], **policy},
                             "metrics_url": "http://127.0.0.1:19801/metrics", "secret_files": {"FIXTURE_TOKEN": str(secret)}}
        assert current == expected_settings, "Composed update changed an unrelated known or unknown setting"
        assert current["capability_policy"]["full_vector_config"] is True
        assert current["capability_policy"]["allowed_network_hosts"] == ["127.0.0.1:19801"]
        assert current["capability_policy"]["future_allowance"] == future
        assert current["future_extension"] == future
        assert current["metrics_url"] == "http://127.0.0.1:19801/metrics"
        assert current["secret_files"] == {"FIXTURE_TOKEN": str(secret)}
        assert read(state_path) == expected_state
        accept_group("All valid supplied settings compose together and reset only suppression", before,
                     ("state/settings.json", "state/state.json"))
        write(state_path, initial_state)
        before = snapshot()
        success(*base, *combined)
        accept_group("Repeating the complete request is byte-identical and preserves later suppression", before)
        before = snapshot()
        success(*base)
        accept_group("Omitting update options preserves every existing setting and retry state", before)

        write(bindings_path, {})
        before = snapshot()
        success(*base, "--allow-full-vector-config=false", "--secret-files", bindings_path)
        current = read(settings_path)
        expected_settings["capability_policy"].pop("full_vector_config", None)
        expected_settings.pop("secret_files", None)
        assert current == expected_settings
        assert not current["capability_policy"].get("full_vector_config", False)
        assert not current.get("secret_files")
        assert current["metrics_url"] == "http://127.0.0.1:19801/metrics"
        assert current["capability_policy"]["allowed_network_hosts"] == ["127.0.0.1:19801"]
        assert read(state_path) == expected_state
        accept_group("Explicit false and empty binding map apply while omitted endpoint and allowances remain", before,
                     ("state/settings.json", "state/state.json"))
        write(state_path, initial_state)
        policy["allowed_network_hosts"] = ["127.0.0.1:19802"]
        write(policy_path, policy)
        before = snapshot()
        success(*base, "--capability-policy", policy_path)
        current = read(settings_path)
        expected_settings["capability_policy"]["allowed_network_hosts"] = ["127.0.0.1:19802"]
        assert current == expected_settings
        assert not current["capability_policy"].get("full_vector_config", False), "Policy JSON implicitly granted full mode"
        assert current["capability_policy"]["allowed_network_hosts"] == ["127.0.0.1:19802"]
        assert read(state_path) == expected_state
        accept_group("Policy JSON cannot grant full mode without the explicit mode option", before,
                     ("state/settings.json", "state/state.json"))

        write(state_path, initial_state)
        write(bindings_path, {"FIXTURE_TOKEN": str(secret)})
        import msvcrt
        with (state_dir / "agent.lock").open("r+b") as held:
            held.seek(0)
            msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                reject_unchanged("Held operation lock refuses the complete valid request", *base, *combined)
            finally:
                held.seek(0)
                msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)
        with deny_delete(settings_path):
            reject_unchanged("Blocked single settings replacement applies none of the composed options", *base, *combined)
        before = snapshot()
        original_state_bytes = state_path.read_bytes()
        with deny_delete(state_path):
            result = call(*base, *combined)
        assert result.returncode != 0
        assert "settings were saved" in result.stderr and "retry-suppression reset is incomplete" in result.stderr
        current = read(settings_path)
        expected_settings["capability_policy"]["full_vector_config"] = True
        expected_settings["secret_files"] = {"FIXTURE_TOKEN": str(secret)}
        assert current == expected_settings
        assert current["capability_policy"]["full_vector_config"] is True
        assert current["metrics_url"] == "http://127.0.0.1:19801/metrics"
        assert current["secret_files"] == {"FIXTURE_TOKEN": str(secret)}
        assert state_path.read_bytes() == original_state_bytes
        accept_group("Late state replacement failure reports all settings saved with reset incomplete", before,
                     ("state/settings.json",), partial_completion=True)
        before = snapshot()
        success("retry", "--state-dir", state_dir)
        assert read(state_path) == expected_state
        accept_group("Explicit recovery retry retains raw state and access after partial state failure", before, ("state/state.json",))

        before = snapshot()
        held_state = state_dir / ".fixture-held-state.json"
        assert state_path.resolve().is_relative_to(fixture.resolve()) and held_state.resolve().is_relative_to(fixture.resolve())
        state_path.rename(held_state)
        try:
            without_state = snapshot()
            result = call(*base)
            assert result.returncode != 0, "Incomplete install was reported as complete"
            assert not state_path.exists() and snapshot() == without_state
        finally:
            held_state.rename(state_path)
        accept_group("Existing settings without state refuse instead of reporting a completed installation", before,
                     fixture_note="Only synthetic state was temporarily renamed and restored with its metadata; no fresh write failure is claimed by this case.")

        fresh = fixture / "fresh-checks"
        fresh.mkdir()
        for name, extra in [
            ("invalid-metrics", ["--metrics-url", "https://example.invalid/metrics"]),
            ("zero-port", ["--metrics-url", "http://127.0.0.1:0/metrics"]),
            ("oversized-port", ["--metrics-url", "http://127.0.0.1:65536/metrics"]),
            ("missing-bindings", ["--secret-files", str(fresh / "missing-bindings.json")]),
            ("missing-policy", ["--capability-policy", str(fresh / "missing-policy.json")]),
        ]:
            new_state, new_managed = fresh / (name + "-state"), fresh / (name + "-managed") / "vector.json"
            before = snapshot()
            directories_before = sorted(str(p.relative_to(fixture)) for p in fixture.rglob("*") if p.is_dir())
            result = call("install", "--state-dir", new_state, "--vector-binary", binary,
                          "--managed-config", new_managed, "--adopt", "--allow-full-vector-config", *extra)
            assert result.returncode != 0
            assert not new_state.exists() and not new_managed.parent.exists()
            assert directories_before == sorted(str(p.relative_to(fixture)) for p in fixture.rglob("*") if p.is_dir())
            accept_group("Fresh " + name + " input creates no state, managed directory or backup", before)

        for name, selected_binary, adopt in [("missing-binary", fresh / "does-not-exist.exe", True),
                                              ("missing-adoption-consent", binary, False)]:
            new_state, new_managed = fresh / (name + "-state"), fresh / (name + "-managed") / "vector.json"
            before = snapshot()
            args_for_fresh = ["install", "--state-dir", new_state, "--vector-binary", selected_binary,
                              "--managed-config", new_managed, "--metrics-url", "http://127.0.0.1:19801/metrics"]
            if adopt:
                args_for_fresh.append("--adopt")
            result = call(*args_for_fresh)
            assert result.returncode != 0 and not new_state.exists() and not new_managed.parent.exists()
            accept_group("Fresh " + name + " refusal creates no installation artifacts", before)

        existing_managed_dir = fresh / "existing-managed"
        existing_managed_dir.mkdir()
        existing_config = existing_managed_dir / "vector.json"
        existing_config.write_bytes(managed.read_bytes())
        dacl(existing_managed_dir, True)
        label(existing_managed_dir, True)
        existing_security = (dacl(existing_managed_dir), label(existing_managed_dir))
        before = snapshot()
        new_state = fresh / "refused-state"
        result = call("install", "--state-dir", new_state, "--vector-binary", binary,
                      "--managed-config", existing_config, "--adopt", "--allow-full-vector-config",
                      "--metrics-url", "https://example.invalid/metrics")
        assert result.returncode != 0 and not new_state.exists()
        assert (dacl(existing_managed_dir), label(existing_managed_dir)) == existing_security
        accept_group("Fresh invalid input cannot change an existing managed directory's access", before)

        new_state = fresh / "policy-only-state"
        result = success("install", "--state-dir", new_state, "--vector-binary", binary,
                         "--managed-config", existing_config, "--adopt", "--capability-policy", policy_path,
                         "--metrics-url", "http://127.0.0.1:19803/metrics", "--secret-files", bindings_path)
        fresh_settings = read(new_state / "settings.json")
        assert not fresh_settings["capability_policy"].get("full_vector_config", False)
        assert fresh_settings["metrics_url"] == "http://127.0.0.1:19803/metrics"
        assert fresh_settings["secret_files"] == {"FIXTURE_TOKEN": str(secret)}
        assert (new_state / "adoption-backup.json").read_bytes() == managed.read_bytes()
        assert read(new_state / "state.json")["apply_state"] == "unmanaged"
        check_access()
        groups.append({"name": "Fresh valid combined install saves supplied values without implicit full-mode grant",
                       "passed": True, "activation": False, "probe_only": True})
        report["source_end_sha256"] = source_snapshot()
        assert report["source_sha256"] == report["source_end_sha256"], "Source changed during native run"
        report["passed"] = True
        report["counts"] = {"groups": len(groups), "commands": len(commands)}
        report["limits"] = ["All historical state and identity fields are synthetic preservation evidence.",
                            "No real service identity, SCM, reboot, audit SACL, enterprise policy or Unix runtime qualification.",
                            "One composed settings replacement still precedes a separate suppression-state commit; late state failure remains explicitly partial.",
                            "Fresh successful install probes the copied Vector version and records adoption; no daemon, validation or workload activation."]
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

