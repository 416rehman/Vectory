"""The packaged systemd unit keeps the agent and the Vector it runs confined."""
from pathlib import Path
import unittest

UNIT = Path(__file__).with_name("systemd") / "vectory.service"
# Directories a unit must never open for writing: that would be the weaker
# sandbox again under a stricter name.
TOO_WIDE = {"/", "/etc", "/usr", "/boot", "/var", "/home", "/root", "/opt", "/srv", "/run"}


def service_settings():
    """The [Service] directives, each as the list of its values. An empty
    assignment resets a directive, as systemd does."""
    values, section = {}, None
    for raw in UNIT.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if section != "Service" or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if value.strip():
            values.setdefault(name.strip(), []).append(value.strip())
        else:
            values[name.strip()] = []
    return values


def writable_paths(settings):
    paths = []
    for value in settings.get("ReadWritePaths", []):
        for path in value.split():
            paths.append(path.removeprefix("-"))
    return paths


class PackagedUnit(unittest.TestCase):
    def test_the_file_system_is_read_only_and_homes_are_out_of_reach(self):
        settings = service_settings()
        self.assertEqual(settings["ProtectSystem"], ["strict"])
        self.assertEqual(settings["ProtectHome"], ["true"])

    def test_the_agent_can_write_what_it_needs_and_nothing_wide(self):
        settings = service_settings()
        paths = writable_paths(settings)
        state_dir = settings["ExecStart"][0].split("--state-dir ", 1)[1].split()[0]
        # The agent's state, and the managed configuration its docs name.
        self.assertIn(state_dir, paths)
        self.assertIn("/etc/vectory/managed", paths)
        for path in paths:
            self.assertTrue(path.startswith("/"), path)
            self.assertNotIn(path.rstrip("/") or "/", TOO_WIDE, path)
            self.assertNotIn("..", Path(path).parts, path)

    def test_a_missing_directory_does_not_stop_the_service(self):
        # Without the leading "-" systemd refuses to start a unit whose
        # ReadWritePaths entry does not exist yet.
        for value in service_settings()["ReadWritePaths"]:
            for path in value.split():
                self.assertTrue(path.startswith("-/"), path)

    def test_stopping_signals_only_the_agent(self):
        settings = service_settings()
        self.assertEqual(settings["KillMode"], ["mixed"])
        self.assertEqual(settings["TimeoutStopSec"], ["330s"])

    def test_the_other_hardening_stays(self):
        settings = service_settings()
        self.assertEqual(settings["NoNewPrivileges"], ["true"])
        self.assertEqual(settings["PrivateTmp"], ["true"])
        self.assertEqual(settings["UMask"], ["0077"])
        self.assertNotIn(settings["User"][0], ("root", "0"))


if __name__ == "__main__":
    unittest.main()
