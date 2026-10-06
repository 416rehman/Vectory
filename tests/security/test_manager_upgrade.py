"""Boundary tests for the maintainer upgrade harness, without a Docker daemon."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("manager_upgrade", Path(__file__).with_name("manager-upgrade.py"))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeBoundaryTests(unittest.TestCase):
    def test_linked_private_parent_cannot_enter_uploaded_artifacts(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            artifact = root / "artifacts"
            artifact.mkdir()
            link = root / "private"
            try:
                os.symlink(artifact, link, target_is_directory=True)
            except OSError:
                self.skipTest("local account cannot create directory symlinks")
            with self.assertRaisesRegex(RuntimeError, "links"):
                upgrade.evidence_destinations(artifact / "proof.json", link / "backup")

    def test_existing_backup_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            backup = root / "backup"
            backup.mkdir()
            with self.assertRaisesRegex(RuntimeError, "must be new"):
                upgrade.evidence_destinations(root / "artifacts" / "proof.json", backup)

    def test_wrong_public_baseline_is_refused_before_loading(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            archive = root / "wrong.tar.gz"
            archive.write_bytes(b"not the published archive")
            with self.assertRaisesRegex(RuntimeError, "pinned checksum"):
                upgrade.baseline_archive(archive, root)

    def test_foreign_resource_is_never_removed(self):
        fixture = upgrade.Fixture(SimpleNamespace())
        fixture.containers = ["someone-elses-container"]
        docker_calls = []
        fixture.docker = lambda *args, **kwargs: docker_calls.append(args)
        fixture.owned = lambda *args: upgrade.require(False, "unowned resource")
        found = subprocess.CompletedProcess(["docker"], 0, b"[]", b"")
        with patch.object(upgrade.subprocess, "run", return_value=found):
            with self.assertRaisesRegex(RuntimeError, "could not all be removed"):
                fixture.cleanup()
        self.assertFalse(docker_calls)

    def test_daemon_failure_is_not_reported_as_absent_cleanup(self):
        fixture = upgrade.Fixture(SimpleNamespace())
        fixture.containers = [fixture.owner + "-manager"]
        unavailable = subprocess.CompletedProcess(["docker"], 1, b"", b"Cannot connect to the Docker daemon")
        with patch.object(upgrade.subprocess, "run", return_value=unavailable):
            with self.assertRaisesRegex(RuntimeError, "could not all be removed"):
                fixture.cleanup()

    def test_already_removed_owned_resource_needs_no_mutation(self):
        fixture = upgrade.Fixture(SimpleNamespace())
        fixture.containers = [fixture.owner + "-manager"]
        absent = subprocess.CompletedProcess(["docker"], 1, b"", b"Error: No such object")
        with patch.object(upgrade.subprocess, "run", return_value=absent):
            fixture.cleanup()
        self.assertFalse(fixture.trial.exists())


if __name__ == "__main__":
    unittest.main()
