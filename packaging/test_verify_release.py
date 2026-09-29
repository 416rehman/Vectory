"""Offline verifier regressions with synthetic archive bytes, never real installs."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("verify_release", Path(__file__).with_name("verify-release.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ArchiveVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.name = "vectory-0.1.0-dev-windows-amd64.exe"
        self.binary = b"synthetic byte identity fixture, not executable"
        (self.root / self.name).write_bytes(self.binary)
        self.members = {
            "vectory.exe": self.binary,
            "LICENSE": b"license",
            "NOTICE": b"notice",
            "docs/AGENT-INSTALL.md": b"instructions",
            "docs/COMPATIBILITY.md": b"limitations",
            "RELEASE-STATUS.txt": b"UNSIGNED DEVELOPMENT BUILD",
            "packaging/windows/install-service.ps1": b"service template",
        }
        (self.root / "catalog.json").write_text(json.dumps([{
            "name": self.name, "os": "windows", "arch": "amd64", "version": "0.1.0-dev",
            "sha256": hashlib.sha256(self.binary).hexdigest(), "size": len(self.binary),
            "url": "/api/v1/releases/" + self.name, "signed": False,
        }]), encoding="utf-8")

    def write_archive(self, extra=None, symlink=False):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.root / (self.name[:-4] + ".zip"), "w") as out:
                for name, value in self.members.items():
                    out.writestr(name, value)
                if extra:
                    if symlink:
                        info = zipfile.ZipInfo(extra)
                        info.create_system = 3
                        info.external_attr = 0o120777 << 16
                        out.writestr(info, "../outside")
                    else:
                        out.writestr(extra, self.binary if extra == "vectory.exe" else b"extra")
        self.checksums()

    def checksums(self):
        (self.root / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n"
            for p in sorted(self.root.iterdir()) if p.name != "SHA256SUMS"
        ), encoding="utf-8")

    def test_complete_archive_passes(self):
        self.write_archive()
        self.assertEqual(verifier.verify(self.root), 1)

    def test_duplicate_binary_is_rejected(self):
        self.write_archive("vectory.exe")
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_traversal_member_is_rejected(self):
        self.write_archive("../outside.txt")
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_symlink_member_is_rejected(self):
        del self.members["LICENSE"]
        self.write_archive("LICENSE", symlink=True)
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_missing_service_material_is_rejected(self):
        del self.members["packaging/windows/install-service.ps1"]
        self.write_archive()
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def test_empty_catalog_is_rejected(self):
        self.write_archive()
        (self.root / "catalog.json").write_text("[]", encoding="utf-8")
        self.checksums()
        with self.assertRaises(ValueError):
            verifier.verify(self.root)

    def write_tar(self, attack=None):
        catalog = json.loads((self.root / "catalog.json").read_text(encoding="utf-8"))
        item = catalog[0]
        item["name"] = "vectory-0.1.0-dev-darwin-arm64"
        item["os"], item["arch"] = "darwin", "arm64"
        item["url"] = "/api/v1/releases/" + item["name"]
        (self.root / item["name"]).write_bytes(self.binary)
        (self.root / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
        members = {**self.members}
        members["vectory"] = members.pop("vectory.exe")
        members["packaging/launchd/io.vectory.agent.plist"] = members.pop("packaging/windows/install-service.ps1")
        if attack == "link":
            del members["LICENSE"]
        with tarfile.open(self.root / (item["name"] + ".tar.gz"), "w:gz") as out:
            for name, value in members.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(value)
                out.addfile(entry, io.BytesIO(value))
            if attack:
                entry = tarfile.TarInfo({"link": "LICENSE", "duplicate": "vectory", "traversal": "../outside"}[attack])
                if attack == "link":
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "../outside"
                    out.addfile(entry)
                else:
                    entry.size = len(self.binary)
                    out.addfile(entry, io.BytesIO(self.binary))
        self.checksums()

    def test_complete_tar_passes(self):
        self.write_tar()
        self.assertEqual(verifier.verify(self.root), 1)

    def test_tar_unsafe_members_are_rejected(self):
        for attack in ("link", "duplicate", "traversal"):
            with self.subTest(attack=attack):
                self.write_tar(attack)
                with self.assertRaises(ValueError):
                    verifier.verify(self.root)


if __name__ == "__main__":
    unittest.main()
