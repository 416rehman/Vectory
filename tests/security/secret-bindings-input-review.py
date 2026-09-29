"""Independent standalone secret-bindings input proof, using only newly-created synthetic state.

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
    paths += list((ROOT / "agent/internal/agent").glob("secret_bindings_input*.go"))
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
    assert output.name.startswith("secret-bindings-input-"), "Use this slice's new bounded output namespace"
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
        alpha, beta = state_dir / "synthetic-alpha.txt", state_dir / "synthetic-beta.txt"
        secret_values = ["SYNTHETIC_ALPHA_PRIVATE_VALUE_27d991", "SYNTHETIC_BETA_PRIVATE_VALUE_18c3a1"]
        alpha.write_text(secret_values[0], encoding="utf-8")
        beta.write_text(secret_values[1], encoding="utf-8")
        input_path = fixture / "bindings.json"
        base = ("configure-secrets", "--state-dir", state_dir)
        write(input_path, {"KEEP": str(alpha), "REMOVE": str(beta)})
        success(*base, "--secret-files", input_path)
        assert read(settings_path)["secret_files"] == {"KEEP": str(alpha), "REMOVE": str(beta)}
        if args.phase == "before":
            report["classification"] = "expected_defect_observation"
            report["correctness_acceptance"] = False
            input_path.write_bytes(b"null")
            before = snapshot()
            result = success(*base, "--secret-files", input_path)
            assert not read(settings_path).get("secret_files")
            accept_group("JSON null silently removes existing synthetic bindings", before, ("state/settings.json",),
                         expected_defect=True, previous_binding_count=2, resulting_binding_count=0)
            input_path.write_text('{"KEEP":' + json.dumps(str(alpha)) + ',"KEEP":' + json.dumps(str(beta)) + '}', encoding="utf-8")
            before = snapshot()
            success(*base, "--secret-files", input_path)
            assert read(settings_path)["secret_files"] == {"KEEP": str(beta)}
            accept_group("Duplicate binding name silently selects the final valid file", before, ("state/settings.json",),
                         expected_defect=True, selected="last supplied file")
            write(input_path, {"POSITIONAL": str(alpha)})
            before = snapshot()
            success(*base, "--secret-files", input_path, "unexpected-positional-argument")
            assert read(settings_path)["secret_files"] == {"POSITIONAL": str(alpha)}
            accept_group("Unexpected positional argument is ignored while supplied replacement applies", before,
                         ("state/settings.json",), expected_defect=True)
        else:
            report["classification"] = "correctness_acceptance"
            current_expected = {**settings, "secret_files": {"KEEP": str(alpha), "REMOVE": str(beta)}}
            assert read(settings_path) == current_expected
            replacement_name = state_dir / "synthetic-replacement-\ufffd.txt"
            replacement_name.write_text(secret_values[0], encoding="utf-8")
            invalid_utf8 = json.dumps({"TOKEN": str(replacement_name)}, ensure_ascii=False).encode().replace(b"\xef\xbf\xbd", b"\xff")
            escaped_replacement = json.dumps({"TOKEN": str(replacement_name)}, ensure_ascii=True).encode()
            invalid_inputs = [
                ("null cannot mean intentional removal", b"null"),
                ("array is not a binding object", b"[]"),
                ("boolean is not a binding object", b"true"),
                ("string is not a binding object", b'"bindings"'),
                ("empty input is not an empty map", b""),
                ("trailing second object is rejected", json.dumps({"TOKEN": str(alpha)}).encode() + b" {}"),
                ("duplicate literal name is rejected", ('{"TOKEN":' + json.dumps(str(alpha)) + ',"TOKEN":' + json.dumps(str(beta)) + '}').encode()),
                ("duplicate escaped name is rejected", (r'{"TOKEN":' + json.dumps(str(alpha)) + r',"\u0054OKEN":' + json.dumps(str(beta)) + '}').encode()),
                ("invalid UTF-8 cannot select an existing replacement-character path", invalid_utf8),
                ("unpaired high surrogate cannot select an existing replacement-character path", escaped_replacement.replace(b"\\ufffd", b"\\ud800")),
                ("unpaired low surrogate cannot select an existing replacement-character path", escaped_replacement.replace(b"\\ufffd", b"\\udc00")),
                ("UTF-8 BOM is rejected", b"\xef\xbb\xbf{}"),
                ("null path is not a string", b'{"TOKEN":null}'),
                ("numeric path is not a string", b'{"TOKEN":42}'),
                ("empty path is rejected", b'{"TOKEN":""}'),
                ("invalid binding name is rejected", json.dumps({"invalid name": str(alpha)}).encode()),
                ("missing bound file is rejected", json.dumps({"TOKEN": str(state_dir / "missing-synthetic.txt")}).encode()),
                ("more than 64 entries is rejected", json.dumps({"TOKEN_" + str(i): str(alpha) for i in range(65)}).encode()),
                ("oversized option document is rejected", b" " * (2 * 1024 * 1024 + 1) + b"{}"),
            ]
            for name, payload in invalid_inputs:
                input_path.write_bytes(payload)
                reject_unchanged("Strict input: " + name, *base, "--secret-files", input_path)
                assert read(settings_path) == current_expected

            write(input_path, {"NEXT": str(beta)})
            reject_unchanged("Missing required binding-file flag is refused", *base)
            reject_unchanged("Empty explicit binding-file path is refused", *base, "--secret-files=")
            reject_unchanged("Missing binding document is refused", *base, "--secret-files", fixture / "missing-map.json")
            reject_unchanged("Unexpected positional input cannot apply a supplied replacement", *base, "--secret-files", input_path, "unexpected-positional-argument")
            reject_unchanged("Positional input before a flag cannot hide it", *base, "unexpected-positional-argument", "--secret-files", input_path)

            before = snapshot()
            success(*base, "--secret-files", input_path)
            current_expected["secret_files"] = {"NEXT": str(beta)}
            assert read(settings_path) == current_expected
            accept_group("A valid map replaces all bindings and preserves unrelated settings/state/access", before, ("state/settings.json",))
            before = snapshot()
            success(*base, "--secret-files", input_path)
            accept_group("Identical map preserves exact file bytes and metadata", before)

            unicode_paths = [("literal replacement character remains valid", replacement_name, False),
                             ("literal non-ASCII path remains valid", state_dir / "synthetic-caf\u00e9.txt", False),
                             ("valid escaped surrogate pair remains valid", state_dir / "synthetic-\U0001f642.txt", True)]
            for name, selected, escaped in unicode_paths:
                selected.write_text(secret_values[0], encoding="utf-8")
                input_path.write_text(json.dumps({"UNICODE": str(selected)}, ensure_ascii=escaped), encoding="utf-8")
                before = snapshot()
                success(*base, "--secret-files", input_path)
                current_expected["secret_files"] = {"UNICODE": str(selected)}
                assert read(settings_path) == current_expected
                accept_group("Unicode compatibility: " + name, before, ("state/settings.json",))

            valid_limit = {"TOKEN_" + str(i): str(alpha) for i in range(64)}
            write(input_path, valid_limit)
            before = snapshot()
            success(*base, "--secret-files", input_path)
            current_expected["secret_files"] = valid_limit
            assert read(settings_path) == current_expected
            accept_group("Exactly 64 valid bindings remain supported", before, ("state/settings.json",))

            write(input_path, {})
            before = snapshot()
            success(*base, "--secret-files", input_path)
            current_expected.pop("secret_files", None)
            assert read(settings_path) == current_expected
            accept_group("Explicit empty object deliberately removes all bindings", before, ("state/settings.json",))
            before = snapshot()
            success(*base, "--secret-files", input_path)
            accept_group("Repeated deliberate empty map is a byte-identical no-op", before)

            write(input_path, {"REVIEWED": str(alpha)})
            import msvcrt
            with (state_dir / "agent.lock").open("r+b") as held:
                held.seek(0)
                msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 1)
                try:
                    reject_unchanged("Held operation lock refuses replacement without altering its access", *base, "--secret-files", input_path)
                finally:
                    held.seek(0)
                    msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 1)
            with deny_delete(settings_path):
                reject_unchanged("Blocked settings replacement preserves prior bindings and state", *base, "--secret-files", input_path)
            before = snapshot()
            success(*base, "--secret-files", input_path)
            current_expected["secret_files"] = {"REVIEWED": str(alpha)}
            assert read(settings_path) == current_expected
            accept_group("A later explicit valid attempt succeeds after the local refusal is resolved", before, ("state/settings.json",))
        assert read(state_path) == initial_state
        for value in secret_values:
            assert all(value not in command["stdout"] + command["stderr"] for command in commands), "Synthetic secret leaked to command output"
        report["secret_values_absent_from_outputs"] = True
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

