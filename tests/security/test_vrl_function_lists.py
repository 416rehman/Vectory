"""The server, the agent and the dashboard must agree about which VRL calls reach outside an event.

The server requires a full-mode device for a pipeline that calls one of them,
and the agent's restricted mode refuses the same set. If the lists drift, a
pipeline is either deployed to a device that then refuses it, or sent to a full
device for no reason. The server also never runs the network functions itself.

Two more functions reach a file only when a call passes one: `parse_groks`
(`alias_sources`, the fourth argument) and `parse_etld` (`psl`, the third).
Pinned Vector opens the file when it compiles the program, so the three readers
scan for such a call alike: the same table of function, argument name and
position, the same bounds, and the programs of
`vector-catalog/fixtures/vrl-file-arguments.json`, which each reader's own tests
run through its own scan.
"""

import json
import math
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


def source(path: str) -> str:
    return (ROOT / path).read_text()


def block(path: str, pattern: str) -> str:
    match = re.search(pattern, source(path), re.S)
    assert match, f"{path}: {pattern!r} not found; did the code move?"
    return match.group(1)


def entries(text: str, entry: str) -> list[tuple[str, str, int, str]]:
    """The (function, argument, position, label) rows of a table written out in one language."""
    rows = [(f, a, int(p), label) for f, a, p, label in re.findall(entry, text, re.S)]
    assert rows, f"no rows in {text[:80]!r}; did the code move?"
    return rows


VALIDATION = "server/src/validation.rs"
ROLLOUT = "server/src/rollout.rs"
POLICY = "agent/internal/agent/policy.go"
SCANNER = "agent/internal/agent/vrl_file_arguments.go"
REQUIREMENTS = "dashboard/src/hostRequirements.ts"
PORT = "dashboard/src/vrlFileArguments.ts"
FIXTURE = json.loads(source("vector-catalog/fixtures/vrl-file-arguments.json"))

# The functions that read a file only when a call passes one, as each reader
# writes them: function, named argument, the argument count at which the file is
# a positional one, and how a refusal names the call.
FILE_ARGUMENTS = {
    "server": entries(
        block(VALIDATION, r"pub const FILE_ARGUMENT_FUNCTIONS: &\[\(&str, &str, usize, &str\)\] = &\[(.*?)\n\];"),
        r'\(\s*"([a-z_]+)",\s*"([a-z_]+)",\s*(\d+),\s*"([^"]+)",?\s*\)',
    ),
    "agent": entries(
        block(SCANNER, r"var fileArgumentFunctions = \[\]fileArgumentFunction\{(.*?)\n\}"),
        r'\{name:\s*"([a-z_]+)",\s*argument:\s*"([a-z_]+)",\s*position:\s*(\d+),\s*label:\s*"([^"]+)"\}',
    ),
    "dashboard": entries(
        block(PORT, r"export const fileArgumentFunctions = \[(.*?)\] as const;"),
        r'name:\s*"([a-z_]+)",\s*argument:\s*"([a-z_]+)",\s*position:\s*(\d+),\s*label:\s*"([^"]+)"',
    ),
}


def product(text: str) -> int:
    """`256` or `32 * 1024`."""
    return math.prod(int(number) for number in re.findall(r"\d+", text))


# How much of a program is read: the most calls to one function, the most bytes
# of one call, and how many times the program's own length may be read in all.
# A program past any of them is taken to pass a file.
BOUNDS = {
    "server": (
        product(block(VALIDATION, r"const MAX_FILE_ARGUMENT_CALLS: usize = ([0-9 *]+);")),
        product(block(VALIDATION, r"const MAX_CALL_BYTES: usize = ([0-9 *]+);")),
        product(block(VALIDATION, r"const MAX_SCAN_FACTOR: usize = ([0-9 *]+);")),
    ),
    "agent": (
        product(block(SCANNER, r"maxFileArgumentCalls\s*=\s*([0-9 *]+)\n")),
        product(block(SCANNER, r"maxCallBytes\s*=\s*([0-9 *]+)\n")),
        product(block(SCANNER, r"maxScanFactor\s*=\s*([0-9 *]+)\n")),
    ),
    "dashboard": (
        product(block(PORT, r"export const maxFileArgumentCalls = ([0-9 *]+);")),
        product(block(PORT, r"export const maxCallBytes = ([0-9 *]+);")),
        product(block(PORT, r"export const maxScanFactor = ([0-9 *]+);")),
    ),
}


class VrlFileArguments(unittest.TestCase):
    def test_the_three_tables_are_the_same(self):
        self.assertEqual(FILE_ARGUMENTS["agent"], FILE_ARGUMENTS["server"])
        self.assertEqual(FILE_ARGUMENTS["dashboard"], FILE_ARGUMENTS["server"])

    def test_the_tables_are_the_fixtures(self):
        rows = [
            (f["function"], f["argument"], f["position"], f["label"])
            for f in FIXTURE["functions"]
        ]
        for reader, table in FILE_ARGUMENTS.items():
            self.assertEqual(table, rows, reader)

    def test_the_bounds_are_the_same(self):
        self.assertEqual(BOUNDS["agent"], BOUNDS["server"])
        self.assertEqual(BOUNDS["dashboard"], BOUNDS["server"])
        bounds = FIXTURE["bounds"]
        self.assertEqual(
            BOUNDS["server"], (bounds["calls"], bounds["call_bytes"], bounds["scan_factor"])
        )

    def test_each_row_is_the_signature_of_a_function_of_the_pinned_vector(self):
        # The position counts arguments from one, in the order the function
        # declares them, so a positional file argument is at that count.
        vrl = json.loads(source("vector-catalog/vrl-functions.json"))
        signatures = {f["name"]: [a["name"] for a in f["arguments"]] for f in vrl["functions"]}
        for function, argument, position, label in FILE_ARGUMENTS["server"]:
            self.assertEqual(signatures[function][position - 1], argument, function)
            self.assertEqual(label, f"{function} with {argument}")

    def test_these_functions_are_not_on_the_lists_of_functions_that_always_reach_out(self):
        # They are ordinary functions until a call passes a file.
        for _, _, _, label in FILE_ARGUMENTS["server"]:
            function = label.split(" with ")[0]
            for name, names in (("server", SERVER), ("agent", AGENT), ("dashboard", DASHBOARD)):
                self.assertNotIn(function, names, name)

    def test_the_fixture_covers_each_function_both_ways(self):
        labels = [row[3] for row in FILE_ARGUMENTS["server"]]
        names = [case["name"] for case in FIXTURE["cases"]]
        self.assertEqual(len(names), len(set(names)), "case names are unique")
        self.assertGreaterEqual(len(names), 60)
        for case in FIXTURE["cases"]:
            self.assertEqual(case["found"], [l for l in labels if l in case["found"]], case["name"])
        for label in labels:
            self.assertTrue(any(label in case["found"] for case in FIXTURE["cases"]), label)
        self.assertTrue(any(not case["found"] for case in FIXTURE["cases"]))

    def test_every_reader_acts_on_the_scan_wherever_it_looks_for_external_functions(self):
        # The server requires a full-mode device for a published version's
        # settings and for its unit tests; the agent refuses in the same two
        # places; the dashboard names the requirement.
        rule = block(ROLLOUT, r"fn requires_full_mode\(config: &Value\) -> bool \{(.*?)\n\}\n")
        self.assertIn("file_argument_calls(value)", block(ROLLOUT, r"fn external_vrl\(value: &str\) -> bool \{(.*?)\n    \}"))
        self.assertIn("calls_device_function(value)", block(ROLLOUT, r"fn external_vrl\(value: &str\) -> bool \{(.*?)\n    \}"))
        self.assertEqual(rule.count("external_vrl(value)"), 2, "settings and unit tests")
        self.assertIn("fileArgumentCalls(program)", block(POLICY, r"func vrlRefusal\((.*?)\n\}\n"))
        self.assertIn("externalFunction(program)", block(POLICY, r"func vrlRefusal\((.*?)\n\}\n"))
        self.assertIn('vrlRefusal(x, "tests")', block(POLICY, r"func checkTests\((.*?)\n\}\n"))
        self.assertIn("vrlRefusal(x, key)", block(POLICY, r"func \(p CapabilityPolicy\) walkIn\((.*?)\n\}\n"))
        inspect = block(REQUIREMENTS, r"export function fullModeRequirements\((.*?)\n\}\n")
        self.assertIn("callsDeviceFunction(value) || fileArgumentCalls(value).length > 0", inspect)
        # The server's checked copy reads the same calls as device resources.
        self.assertIn(
            "calls_device_function(text) || !file_argument_calls(text).is_empty()",
            block(VALIDATION, r"pub fn device_context_reasons\(config: &Value\) -> Vec<String> \{(.*?)\n\}\n"),
        )


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
