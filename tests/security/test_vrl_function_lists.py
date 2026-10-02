"""The server and the agent must agree about which VRL functions reach outside an event.

The server requires a full-mode device for a pipeline that calls one of them,
and the agent's restricted mode refuses the same set. If the lists drift, a
pipeline is either deployed to a device that then refuses it, or sent to a full
device for no reason. The server also never runs the network functions itself.
"""

import json
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
DASHBOARD = names(
    "dashboard/src/hostRequirements.ts",
    r"export const deviceVrlFunctions = \[(.*?)\] as const;",
)
FILES = names(
    "server/src/validation.rs", r"pub const FILE_VRL_FUNCTIONS: &\[&str\] = &\[(.*?)\];"
)
# The capability table splits the list: functions restricted mode refuses, and
# functions only a device can evaluate. Enrichment lookups leave the first,
# because Vector refuses a table the configuration doesn't declare.
TABLE = json.loads((ROOT / "dashboard/src/generated/capability-table.json").read_text())[
    "vrl_functions"
]
ENRICHMENT = ["find_enrichment_table_records", "get_enrichment_table_record"]


class VrlFunctionLists(unittest.TestCase):
    def test_server_requirement_matches_agent_refusal(self):
        self.assertEqual(SERVER, AGENT)

    def test_dashboard_requirement_matches_agent_refusal(self):
        self.assertEqual(DASHBOARD, AGENT)

    def test_network_functions_are_device_functions(self):
        self.assertTrue(NETWORK)
        self.assertLessEqual(set(NETWORK), set(SERVER))
        self.assertLessEqual(set(NETWORK), set(AGENT))

    def test_file_functions_are_device_functions(self):
        self.assertTrue(FILES)
        self.assertLessEqual(set(FILES), set(SERVER))
        self.assertLessEqual(set(FILES), set(AGENT))
        self.assertTrue(set(FILES).isdisjoint(NETWORK))

    def test_every_name_is_a_function_of_the_pinned_vector(self):
        # A misspelled or shortened name (`get_enrichment_table` matched only as
        # a substring of the real ones) would silently stop matching calls.
        vrl = json.loads((ROOT / "vector-catalog/vrl-functions.json").read_text())
        known = {f["name"] for f in vrl["functions"]}
        # Vector's enrichment-table functions are registered with the tables,
        # not in the standalone VRL catalog.
        known |= {"get_enrichment_table_record", "find_enrichment_table_records"}
        self.assertEqual(sorted(set(SERVER) - known), [])

    def test_the_lists_are_not_empty(self):
        self.assertGreaterEqual(len(SERVER), 12)

    def test_capability_table_device_functions_match_the_server(self):
        self.assertEqual(TABLE["device_only"], SERVER)

    def test_capability_table_refuses_all_but_the_enrichment_lookups(self):
        self.assertEqual(TABLE["refused"], sorted(set(SERVER) - set(ENRICHMENT)))
        self.assertTrue(set(NETWORK) <= set(TABLE["refused"]))
        self.assertTrue(set(FILES) <= set(TABLE["refused"]))


if __name__ == "__main__":
    unittest.main()
