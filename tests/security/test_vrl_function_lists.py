"""The server and the agent must agree about which VRL functions reach outside an event.

The server requires a full-mode device for a pipeline that calls one of them,
and the agent's restricted mode refuses the same set. If the lists drift, a
pipeline is either deployed to a device that then refuses it, or sent to a full
device for no reason. The server also never runs the network functions itself.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[2]


def names(path: str, pattern: str) -> list[str]:
    text = (ROOT / path).read_text()
    match = re.search(pattern, text, re.S)
    assert match, f"{path}: list not found"
    return sorted(re.findall(r'"([a-z_]+)"', match.group(1)))


SERVER = names(
    "server/src/validation.rs", r"pub const DEVICE_VRL_FUNCTIONS: &\[&str\] = &\[(.*?)\];"
)
NETWORK = names(
    "server/src/validation.rs", r"pub const NETWORK_VRL_FUNCTIONS: &\[&str\] = &\[(.*?)\];"
)
AGENT = names("agent/internal/agent/policy.go", r"var externalVRL = \[\]string\{(.*?)\}")


class VrlFunctionLists(unittest.TestCase):
    def test_server_requirement_matches_agent_refusal(self):
        self.assertEqual(SERVER, AGENT)

    def test_network_functions_are_device_functions(self):
        self.assertTrue(NETWORK)
        self.assertLessEqual(set(NETWORK), set(SERVER))
        self.assertLessEqual(set(NETWORK), set(AGENT))

    def test_the_lists_are_not_empty(self):
        self.assertGreaterEqual(len(SERVER), 9)


if __name__ == "__main__":
    unittest.main()
