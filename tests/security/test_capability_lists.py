"""The agent, the server and the dashboard must agree about what restricted mode accepts.

The agent enforces restricted mode (`CapabilityPolicy.Check` in policy.go). The
server decides from a published version whether a deployment needs a full-mode
device (`requires_full_mode` in rollout.rs), and the dashboard says so before a
pipeline is chosen (`fullModeRequirements` in hostRequirements.ts). The server
and the dashboard read the component set from the catalog, where `localTypes`
in scripts/generate-vector-catalog.mjs marks it. If the copies drift, a
deployment reaches a device that then refuses it, or is blocked for no reason:
the server and the agent once disagreed about the `api` block that way.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[2]
SECTIONS = ("sources", "transforms", "sinks")


def read(path: str) -> str:
    return (ROOT / path).read_text()


def block(path: str, pattern: str) -> str:
    match = re.search(pattern, read(path), re.S)
    assert match, f"{path}: {pattern!r} not found; did the code move?"
    return match.group(1)


def quoted(text: str) -> list[str]:
    return sorted(set(re.findall(r'"([a-z0-9_]+)"', text)))


def components(text: str, item: str) -> dict[str, list[str]]:
    """Section -> sorted type names, from `"section": {...}` or `section: [...]` blocks."""
    found = {}
    for section in SECTIONS:
        match = re.search(rf'"?{section}"?\s*:\s*[{{\[](.*?)[}}\]]', text, re.S)
        assert match, f"no {section} list"
        found[section] = sorted(re.findall(item, match.group(1)))
    return found


def catalog_components(path: str) -> dict[str, list[str]]:
    catalog = json.loads(read(path))
    found = {section: [] for section in SECTIONS}
    for component in catalog["components"]:
        if component["device_capability"] == "allowed":
            found[component["kind"]].append(component["type"])
    return {section: sorted(types) for section, types in found.items()}


POLICY = "agent/internal/agent/policy.go"
ROLLOUT = "server/src/rollout.rs"
DASHBOARD = "dashboard/src/hostRequirements.ts"

AGENT_COMPONENTS = components(
    block(POLICY, r"var supported = map\[string\]map\[string\]bool\{(.*?)\n\}"),
    r'"([a-z0-9_]+)":\s*true',
)
LOCAL_TYPES = components(
    block("scripts/generate-vector-catalog.mjs", r"const localTypes = \{(.*?)\n\};"),
    r'"([a-z0-9_]+)"',
)
SERVER_CATALOG = catalog_components("vector-catalog/catalog.json")
DASHBOARD_CATALOG = catalog_components("dashboard/src/generated/vector-catalog.json")

AGENT_CHECK = block(POLICY, r"func \(p CapabilityPolicy\) Check\(data \[\]byte\) error \{(.*?)\n\}\n")
AGENT_WALK = block(POLICY, r"func \(p CapabilityPolicy\) walkIn\((.*?)\n\}\n")
SERVER_RULE = block(ROLLOUT, r"fn requires_full_mode\(config: &Value\) -> bool \{(.*?)\n\}\n")
DASHBOARD_RULE = block(
    DASHBOARD, r"export function fullModeRequirements\((.*?)\n\}\n"
)


def agent_cases() -> dict[str, str]:
    """Top-level keys the agent's `switch k` names, each with its case body."""
    switch = AGENT_CHECK[AGENT_CHECK.index("switch k {") :]
    cases = {}
    parts = re.split(r"\n\t\tcase ((?:\"[a-z_]+\",?\s*)+):", switch)
    for labels, body in zip(parts[1::2], parts[2::2]):
        body = body.split("\n\t\tdefault:")[0]
        for label in quoted(labels):
            cases[label] = body
    return cases


AGENT_CASES = agent_cases()
AGENT_ROOTS = sorted(key for key, body in AGENT_CASES.items() if "refusal(" not in body)
SERVER_ROOTS = quoted(block(ROLLOUT, r"let restricted_roots = \[(.*?)\];"))
DASHBOARD_ROOTS = quoted(block(DASHBOARD, r"const restrictedRoots = new Set\(\[(.*?)\]\);"))

AGENT_REFUSED_KEYS = quoted(
    re.search(r'if (lower == "command"(?: \|\| lower == "[a-z_]+")+) \{', AGENT_WALK).group(1)
)
SERVER_REFUSED_KEYS = quoted(
    re.search(r'\[\s*("command",.*?)\]\s*\.contains\(&key\.as_str\(\)\)', SERVER_RULE, re.S).group(1)
)
DASHBOARD_REFUSED_KEYS = quoted(
    re.search(r'\[\s*("command",.*?)\]\.includes\(key\.toLowerCase\(\)\)', DASHBOARD_RULE, re.S).group(1)
)


class RestrictedModeLists(unittest.TestCase):
    def test_the_component_sets_are_not_empty(self):
        for section in SECTIONS:
            self.assertGreaterEqual(len(AGENT_COMPONENTS[section]), 6, section)

    def test_catalog_marks_exactly_the_agent_component_set(self):
        self.assertEqual(LOCAL_TYPES, AGENT_COMPONENTS)

    def test_server_and_dashboard_catalog_copies_match_the_agent(self):
        # vector-catalog/catalog.json is what the server compiles in;
        # dashboard/src/generated/vector-catalog.json is what the dashboard reads.
        self.assertEqual(SERVER_CATALOG, AGENT_COMPONENTS)
        self.assertEqual(DASHBOARD_CATALOG, AGENT_COMPONENTS)

    def test_server_and_dashboard_read_the_marked_component_set(self):
        self.assertIn('include_str!("../../vector-catalog/catalog.json")', SERVER_RULE)
        self.assertIn('component["device_capability"] == "allowed"', SERVER_RULE)
        self.assertIn('known.device_capability === "allowed"', DASHBOARD_RULE)

    def test_top_level_settings_match(self):
        self.assertEqual(AGENT_ROOTS, SERVER_ROOTS)
        self.assertEqual(AGENT_ROOTS, DASHBOARD_ROOTS)
        self.assertTrue(set(SECTIONS) <= set(AGENT_ROOTS))

    def test_the_api_block_is_host_owned_everywhere(self):
        self.assertIn("LOCAL_API_DENIED", AGENT_CASES["api"])
        self.assertNotIn("api", SERVER_ROOTS)
        self.assertNotIn("api", DASHBOARD_ROOTS)

    def test_refused_keys_match(self):
        self.assertIn("command", AGENT_REFUSED_KEYS)
        self.assertEqual(SERVER_REFUSED_KEYS, AGENT_REFUSED_KEYS)
        self.assertEqual(DASHBOARD_REFUSED_KEYS, AGENT_REFUSED_KEYS)

    def test_tls_verification_stays_on_everywhere(self):
        self.assertIn('lower == "verify_certificate" || lower == "verify_hostname"', AGENT_WALK)
        self.assertIn('["verify_certificate", "verify_hostname"]', SERVER_RULE)
        self.assertIn('["verify_certificate", "verify_hostname"]', DASHBOARD_RULE)

    def test_substitutions_and_templates_need_full_mode_everywhere(self):
        self.assertIn(r"regexp.MustCompile(`\$[A-Za-z_]`)", read(POLICY))
        for marker in ("${", "{{", "%{"):
            self.assertIn(f'strings.Contains(x, "{marker}")', AGENT_WALK, marker)
            self.assertIn(f'value.contains("{marker}")', SERVER_RULE, marker)
        self.assertIn("pair[0] == b'$' && (pair[1].is_ascii_alphabetic() || pair[1] == b'_')", SERVER_RULE)
        self.assertIn(r"/\$[A-Za-z_{]|SECRET\[|\{\{|%\{/", DASHBOARD_RULE)
        # Native secret references: the server and the dashboard look for
        # SECRET[; the agent refuses the `secret` backends they need instead.
        self.assertIn('value.contains("SECRET[")', SERVER_RULE)
        self.assertIn("secret", AGENT_REFUSED_KEYS)

    def test_console_and_remap_file_rules_match(self):
        self.assertIn('c["target"]; target != "stderr"', read(POLICY))
        self.assertIn('typ == "console" && component["target"] != "stderr"', SERVER_RULE)
        self.assertIn('component?.type === "console" && component.target !== "stderr"', DASHBOARD_RULE)
        self.assertIn('c["file"]; ok && typ == "remap"', read(POLICY))
        self.assertIn('typ == "remap" && !component["file"].is_null()', SERVER_RULE)
        self.assertIn('component?.type === "remap" &&', DASHBOARD_RULE)


if __name__ == "__main__":
    unittest.main()
