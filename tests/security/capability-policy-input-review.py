"""Independent capability-policy input proof, using only newly-created synthetic state.

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
    paths += list((ROOT / "agent/internal/agent").glob("capability_policy_input*.go"))
    paths += list((ROOT / "agent/internal/agent").glob("operator_input*.go"))
    paths += list((ROOT / "agent/internal/agent").glob("secret_bindings_input*.go"))
    paths += list((ROOT / "agent/cmd/vectory").glob("capability_policy_input*.go"))
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
    parser.add_argument("--phase", choices=["before", "after"], required=True)
    parser.add_argument("--vector", type=Path, default=ROOT / ".local/tools/vector-0.58.0/bin/vector.exe")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert os.name == "nt", "This harness qualifies Windows only"
    agent, output = args.agent.resolve(), args.output.resolve()
    assert output.is_relative_to(ROOT / ".local")
    assert output.name.startswith("capability-policy-input-"), "Use this slice's new bounded output namespace"
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
              "source_sha256": source_snapshot(), "phase": args.phase, "fixture_path": str(fixture), "fixture_removed": False}

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
        settings = read(settings_path)
        future = {"exact": 18446744073709551615, "list": [None, False, 9007199254740993]}
        original_root = fixture / "allowed-original"
        replacement_root = fixture / "allowed-\ufffd"
        unicode_root = fixture / "allowed-caf\u00e9"
        emoji_root = fixture / "allowed-\U0001f511"
        for path in [original_root, replacement_root, unicode_root, emoji_root]:
            path.mkdir()
        settings["capability_policy"]["allowed_file_roots"] = [str(original_root)]
        settings["future_extension"] = future
        settings["capability_policy"]["future_allowance"] = future
        settings["server"] = "https://synthetic-instance.invalid"
        settings["name"] = "synthetic-preserved-identity"
        write(settings_path, settings)
        initial_state = read(state_path)
        initial_state.update({"device_id": "0bf8c5e2-9a45-457a-a887-8028798a1810", "highest_generation": 34,
                              "highest_policy_generation": 28, "reported_generation": 33, "accepted": True,
                              "apply_state": "failed", "failed_generation": 34, "failed_effective_sha256": "b" * 64,
                              "actual_sha256": "a" * 64, "last_good_sha256": "a" * 64, "secret_revision": 24,
                              "applied_secret_revision": 23, "future_state": future,
                              "policy": {"heartbeat_seconds": 90, "sync_paused": True, "telemetry_enabled": False},
                              "error": {"code": "VALIDATION_FAILED", "stage": "validation", "message": "Synthetic retained rejection"}})
        write(state_path, initial_state)
        (state_dir / "paused").write_bytes(b"Synthetic durable local pause\n")
        (state_dir / "fixture-identity.txt").write_bytes(b"Synthetic marker, not a credential\n")
        for path in [state_dir, settings_path, state_path, state_dir / "agent.lock"]:
            dacl(path, True)
            label(path, True)
        expected_access = access()
        report["fixture_access"] = expected_access
        policy_path = fixture / "policy.json"
        base = ("install", "--state-dir", state_dir, "--capability-policy", policy_path)
        def policy(path):
            return {"full_vector_config": True, "allowed_file_roots": [str(path)], "allowed_network_hosts": [], "allowed_listen_addresses": []}
        baseline = policy(original_root)
        expected_after_state = {k: v for k, v in initial_state.items() if k not in ("failed_generation", "failed_effective_sha256")}

        def reset_baseline():
            write(policy_path, baseline)
            success(*base)
            write(state_path, initial_state)
            assert read(settings_path)["capability_policy"]["allowed_file_roots"] == [str(original_root)]

        def check_policy_change(name, payload, selected, expected_defect=False):
            reset_baseline()
            policy_path.write_bytes(payload)
            before = snapshot()
            success(*base)
            saved = read(settings_path)
            assert saved["capability_policy"]["allowed_file_roots"] == [str(selected)]
            assert not saved["capability_policy"].get("full_vector_config", False)
            expected = {**settings, "capability_policy": {**settings["capability_policy"], "allowed_file_roots": [str(selected)], "allowed_network_hosts": [], "allowed_listen_addresses": []}}
            assert saved == expected
            assert read(state_path) == expected_after_state
            accept_group(name, before, ("state/settings.json", "state/state.json"), expected_defect=expected_defect,
                         saved_path=str(selected).replace(str(fixture), "<private-fixture>"),
                         saved_path_exists=selected.is_dir(), suppression_reset_only=True)

        raw = json.dumps(policy(replacement_root), ensure_ascii=False).encode("utf-8")
        malformed_utf8 = raw.replace("\ufffd".encode("utf-8"), b"\xff")
        escaped = json.dumps(policy(replacement_root), ensure_ascii=True)
        malformed_high = escaped.replace("\\ufffd", "\\ud800").encode("ascii")
        malformed_low = escaped.replace("\\ufffd", "\\udc00").encode("ascii")
        if args.phase == "before":
            report["classification"] = "expected_lossy_input_observation"
            report["correctness_acceptance"] = False
            for case_name, payload in [("Malformed UTF-8", malformed_utf8), ("Lone high surrogate", malformed_high), ("Lone low surrogate", malformed_low)]:
                check_policy_change(case_name + " silently saves a different actual U+FFFD allowance root", payload, replacement_root, True)
            check_policy_change("Legitimate literal U+FFFD allowance root remains an exact control", raw, replacement_root)
            check_policy_change("Legitimate non-ASCII allowance root remains an exact control", json.dumps(policy(unicode_root), ensure_ascii=False).encode("utf-8"), unicode_root)
            check_policy_change("Legitimate paired surrogate allowance root remains an exact control", json.dumps(policy(emoji_root), ensure_ascii=True).encode("ascii"), emoji_root)
        else:
            report["classification"] = "correctness_acceptance"
            reset_baseline()
            valid_bytes = json.dumps(policy(replacement_root), ensure_ascii=False).encode("utf-8")
            cases = [
                ("malformed UTF-8 cannot become an actual U+FFFD root", malformed_utf8),
                ("lone high surrogate cannot become an actual U+FFFD root", malformed_high),
                ("lone low surrogate cannot become an actual U+FFFD root", malformed_low),
                ("root null is not a policy object", b"null"),
                ("root array is not a policy object", b"[]"),
                ("root boolean is not a policy object", b"true"),
                ("empty input is not a policy object", b""),
                ("UTF-8 BOM is rejected", b"\xef\xbb\xbf" + valid_bytes),
                ("trailing second object is rejected", valid_bytes + b" {}"),
                ("duplicate known field is rejected", b'{"allowed_file_roots":[],"allowed_file_roots":null}'),
                ("escaped duplicate known field is rejected", b'{"allowed_file_roots":[],"allowed_\\u0066ile_roots":null}'),
                ("unknown field is rejected", b'{"allowed_file_roots":[],"allow_everything":true}'),
                ("mode null is invalid", b'{"full_vector_config":null}'),
                ("mode wrong type is invalid", b'{"full_vector_config":"true"}'),
                ("allowance list cannot be a string", b'{"allowed_file_roots":"relative"}'),
                ("allowance list cannot be an object", b'{"allowed_file_roots":{}}'),
                ("null list member is invalid", b'{"allowed_file_roots":[null]}'),
                ("numeric list member is invalid", b'{"allowed_file_roots":[3]}'),
                ("relative root is invalid", b'{"allowed_file_roots":["relative"]}'),
                ("wildcard root is invalid", json.dumps({"allowed_file_roots":[str(original_root)+"*"]}).encode()),
                ("NUL root is invalid", b'{"allowed_file_roots":["C:/\\u0000"]}'),
                ("network allowance missing port is invalid", b'{"allowed_network_hosts":["synthetic.invalid"]}'),
                ("listener allowance out-of-range port is invalid", b'{"allowed_listen_addresses":["127.0.0.1:65536"]}'),
                ("more than 1024 allowance entries is rejected", json.dumps({"allowed_file_roots":[str(original_root)]*1025}).encode()),
                ("overlong allowance string is rejected", json.dumps({"allowed_file_roots":["C:/"+"a"*32768]}).encode()),
                ("oversized document is rejected", b" "*(2*1024*1024)+b"{}"),
            ]
            for case_name, payload in cases:
                policy_path.write_bytes(payload)
                reject_unchanged("Input refusal: " + case_name, *base)
            reject_unchanged("Empty policy-file flag is refused", "install", "--state-dir", state_dir, "--capability-policy=")
            reject_unchanged("Missing policy file is refused", "install", "--state-dir", state_dir, "--capability-policy", fixture / "absent-policy.json")
            policy_path.write_bytes(malformed_utf8)
            reject_unchanged("Malformed policy prevents requested mode and metrics changes", *base, "--allow-full-vector-config", "--metrics-url", "http://127.0.0.1:19811/metrics")
            fresh = fixture / "fresh-refused"
            reject_unchanged("Fresh malformed policy creates no state, managed directory or backup", "install", "--state-dir", fresh, "--vector-binary", binary, "--managed-config", fixture / "fresh-managed" / "managed.json", "--adopt", "--capability-policy", policy_path)
            assert not fresh.exists() and not (fixture / "fresh-managed").exists()

            check_policy_change("Valid literal U+FFFD root is preserved exactly", raw, replacement_root)
            check_policy_change("Valid non-ASCII root is preserved exactly", json.dumps(policy(unicode_root), ensure_ascii=False).encode(), unicode_root)
            check_policy_change("Valid escaped surrogate pair is preserved exactly", json.dumps(policy(emoji_root), ensure_ascii=True).encode("ascii"), emoji_root)
            backslash_root = fixture / "ud800"
            backslash_root.mkdir()
            check_policy_change("Escaped Windows backslash before ud800 is literal path text", json.dumps(policy(backslash_root), ensure_ascii=True).encode("ascii"), backslash_root)
            write(state_path, initial_state)
            before = snapshot()
            success(*base)
            assert read(state_path) == initial_state
            accept_group("Repeated same Unicode policy preserves exact bytes and later suppression", before)

            for case_name, payload, roots in [("null allowance lists", {"allowed_file_roots":None,"allowed_network_hosts":None,"allowed_listen_addresses":None}, None),
                                              ("omitted allowance lists", {}, None),
                                              ("empty allowance arrays", {"allowed_file_roots":[],"allowed_network_hosts":[],"allowed_listen_addresses":[]}, [])]:
                reset_baseline()
                write(policy_path, payload)
                before = snapshot()
                success(*base)
                current = read(settings_path)
                expected = {**settings, "capability_policy":{**settings["capability_policy"],"allowed_file_roots":roots,"allowed_network_hosts":roots,"allowed_listen_addresses":roots}}
                assert current == expected and read(state_path) == expected_after_state
                accept_group("Compatibility: " + case_name + " deliberately replaces lists with empty allowances", before, ("state/settings.json","state/state.json"))
                write(state_path, initial_state)
                before = snapshot()
                success(*base)
                accept_group("No-op compatibility: repeated " + case_name + " preserves exact bytes and suppression", before)

            reset_baseline()
            write(policy_path, policy(replacement_root))
            import msvcrt
            with (state_dir / "agent.lock").open("r+b") as held:
                held.seek(0)
                msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
                try:
                    reject_unchanged("Held operation lock refuses a valid changed policy", *base)
                finally:
                    held.seek(0)
                    msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)
            with deny_delete(settings_path):
                reject_unchanged("Refused settings replacement preserves policy and suppression", *base)
            before = snapshot()
            success(*base)
            assert read(state_path) == expected_after_state
            assert read(settings_path)["capability_policy"]["allowed_file_roots"] == [str(replacement_root)]
            accept_group("A later explicit valid policy succeeds after local refusal resolves", before, ("state/settings.json","state/state.json"))
        report["no_workload_or_resource_access"] = True
        report["state_scope"] = "Changed capability allowance resets only documented failure-suppression fields; unrelated state, counters, pause, identity markers and raw settings values remain intact. No allowance was exercised by a workload."
        report["source_end_sha256"] = source_snapshot()
        assert report["source_sha256"] == report["source_end_sha256"], "Source changed during execution"
        report["passed"] = True
        report["counts"] = {"groups": len(groups), "commands": len(commands)}
        report["limits"] = ["Synthetic protected files and seeded state only; no credential material, enrollment, workload or service.",
                            "Before groups are expected observations, excluded from correctness acceptance counts; the final after matrix is a separate run.",
                            "Metadata check uses current operator and synthetic grants/MIC, not SCM impersonation or Unix runtime proof."]
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        if report["passed"]:
            assert fixture.resolve().parent == output and fixture.name.startswith("fixture-")
            shutil.rmtree(fixture)
            report["fixture_removed"] = not fixture.exists()
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "phase": args.phase, "groups": len(groups), "report": str(output / "report.json")}))


if __name__ == "__main__":
    main()

