"""The agent, the server and the dashboard must agree about what restricted mode accepts.

The agent enforces restricted mode (`CapabilityPolicy.Check` in policy.go). The
server decides from a published version whether a deployment needs a full-mode
device (`requires_full_mode` in rollout.rs), and the dashboard says so before a
pipeline is chosen (`fullModeRequirements` in hostRequirements.ts). The server
and the dashboard read the component set from the catalog, where `localTypes`
in scripts/generate-vector-catalog.mjs marks it. If the copies drift, a
deployment reaches a device that then refuses it, or is blocked for no reason:
the server and the agent once disagreed about the `api` block that way.

Two AWS credential shapes are refused whatever the host allows, so the three
copies must also agree about them: a `credentials_file` key below an `auth`
key (it can make Vector run a program), and a sink that signs with the AWS
strategy without explicit keys (it would sign with the host's own identity).
The four sink types that take the credential and where each reads it, the keys
that make it explicit, the keys that borrow the host's identity and the
credentials file key are held in `credentialRefusal` and `awsCredentialPath` in
policy.go, in `requires_full_mode` and its helpers in rollout.rs, and in
`fullModeRequirements` and its helpers in hostRequirements.ts.

The capability table (vector-catalog/capabilities.json) will replace these
lists. Until the three readers use it, its `current_restricted_mode` section
must equal them and the tiers must keep every one of them built in, and its
`aws` credential shape and the credential paths of its sinks must agree with
the rules. They differ in one place: the table counts `access_key_id` alone as
explicit, while the agent, which enforces, requires both keys, and the server
and the dashboard follow the agent.
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


def credential_paths(text: str, entry: str) -> dict[str, list[str]]:
    """Sink type -> the path of its AWS credential, from the `entry` matches of a table."""
    found = {sink: re.findall(r'"([a-z_]+)"', path) for sink, path in re.findall(entry, text)}
    assert found, f"no credential paths in {text[:60]!r}; did the code move?"
    return found


# Where each restricted-mode sink that takes an AWS credential reads it.
AGENT_AWS_PATHS = credential_paths(
    block(POLICY, r"awsCredentialPath = map\[string\]\[\]string\{(.*?)\n\t\}"),
    r'"([a-z_]+)":\s*\{([^}]*)\}',
)
SERVER_AWS_PATHS = credential_paths(
    block(ROLLOUT, r"const AWS_CREDENTIAL_PATHS: \[\(&str, &\[&str\]\); \d+\] = \[(.*?)\n\];"),
    r'\("([a-z_]+)", &\[([^\]]*)\]\)',
)
DASHBOARD_AWS_PATHS = credential_paths(
    block(DASHBOARD, r"const awsCredentialPaths = new Map\(\[(.*?)\]\);"),
    r'\["([a-z_]+)", \[([^\]]*)\]\]',
)
# The keys that make the credential explicit, the keys that borrow the host's
# identity, and the key that names a credentials file.
AGENT_AWS_KEYS = {
    "explicit": quoted(block(POLICY, r"awsExplicitKeys\s*=\s*\[\]string\{(.*?)\}")),
    "ambient": quoted(block(POLICY, r"awsAmbientKeys\s*=\s*\[\]string\{(.*?)\}")),
    "file": quoted(block(POLICY, r'const credentialsFileKey = ("[a-z_]+")')),
}
SERVER_AWS_KEYS = {
    "explicit": quoted(block(ROLLOUT, r"const AWS_EXPLICIT_KEYS: \[&str; \d+\] = \[(.*?)\];")),
    "ambient": quoted(block(ROLLOUT, r"const AWS_AMBIENT_KEYS: \[&str; \d+\] = \[(.*?)\];")),
    "file": quoted(block(ROLLOUT, r'const CREDENTIALS_FILE_KEY: &str = ("[a-z_]+");')),
}
DASHBOARD_AWS_KEYS = {
    "explicit": quoted(block(DASHBOARD, r"const awsExplicitKeys = \[(.*?)\];")),
    "ambient": quoted(block(DASHBOARD, r"const awsAmbientKeys = \[(.*?)\];")),
    "file": quoted(block(DASHBOARD, r'const credentialsFileKey = ("[a-z_]+");')),
}
# The code of each rule, for the checks that the copies read a name or a value
# the same way: the credentials file, the strategy, and the keys of a credential.
AGENT_COMPONENT = block(POLICY, r"func \(p CapabilityPolicy\) component\((.*?)\n\}\n")
AGENT_FILE_FIELD = block(POLICY, r"func credentialsFileField\((.*?)\n\}\n")
AGENT_AMBIENT = block(POLICY, r"func ambientAWSRefusal\((.*?)\n\}\n")
AGENT_EXPLICIT = block(POLICY, r"func explicitAWSCredential\((.*?)\n\}\n")
SERVER_FILE_FIELD = block(ROLLOUT, r"fn credentials_file_below_auth\((.*?)\n\}\n")
SERVER_AMBIENT = block(ROLLOUT, r"fn signs_with_host_identity\((.*?)\n\}\n")
SERVER_EXPLICIT = block(ROLLOUT, r"fn explicit_aws_credential\((.*?)\n\}\n")
DASHBOARD_FILE_FIELD = block(DASHBOARD, r"function credentialsFileBelowAuth\((.*?)\n\}\n")
DASHBOARD_AMBIENT = block(DASHBOARD, r"function signsWithHostIdentity\((.*?)\n\}\n")
DASHBOARD_EXPLICIT = block(DASHBOARD, r"function explicitAwsCredential\((.*?)\n\}\n")


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


TABLE = json.loads(read("dashboard/src/generated/capability-table.json"))
CURRENT = TABLE["current_restricted_mode"]
SCOPES = {
    scope["scope"]: scope
    for scope in TABLE["components"] + TABLE["global_settings"] + TABLE["enrichment_tables"]
}


class CapabilityTable(unittest.TestCase):
    def test_current_section_equals_the_code(self):
        self.assertEqual({s: sorted(CURRENT["components"][s]) for s in SECTIONS}, AGENT_COMPONENTS)
        roots = sorted([*CURRENT["global_settings"], "tests", *SECTIONS])
        self.assertEqual(roots, AGENT_ROOTS)

    def test_what_restricted_mode_runs_today_stays_built_in(self):
        for section in SECTIONS:
            for typ in CURRENT["components"][section]:
                self.assertEqual(SCOPES[f"{section}/{typ}"]["tier"], "builtin", typ)
        for key in [*CURRENT["global_settings"], "tests"]:
            self.assertEqual(SCOPES[f"global/{key}"]["tier"], "builtin", key)

    def test_the_api_block_stays_host_owned(self):
        self.assertEqual(SCOPES["global/api"]["tier"], "full")
        self.assertEqual(SCOPES["global/api"]["code"], "LOCAL_API_DENIED")

    def test_programs_providers_and_secret_backends_stay_full(self):
        for scope in ["sources/exec", "transforms/lua", "global/provider", "global/secret"]:
            self.assertEqual(SCOPES[scope]["tier"], "full", scope)

    def test_the_table_keeps_todays_refusals(self):
        markers = {rule.get("contains") or rule.get("pattern") for rule in TABLE["string_rules"]}
        self.assertTrue({"${", "{{", "%{", "SECRET[", r"\$[A-Za-z_]"} <= markers)
        console = SCOPES["sinks/console"]["rules"]["target"]
        self.assertEqual((console["allowed"], console["default"]), (["stderr"], "stdout"))
        self.assertEqual(SCOPES["transforms/remap"]["rules"]["file"]["class"], "refused")
        for scope in ["sinks/http", "sinks/loki", "sinks/elasticsearch"]:
            rule = SCOPES[scope]["rules"]["tls.verify_certificate"]
            self.assertEqual(rule["refused_values"], [False], scope)

    def test_unreviewed_components_need_full_mode(self):
        for scope in TABLE["components"]:
            if not scope["reviewed"]:
                self.assertEqual(scope["tier"], "full", scope["scope"])


def table_aws_paths() -> dict[str, list[str]]:
    """Restricted-mode sink type -> where the table says it reads its AWS credential."""
    found = {}
    for typ in AGENT_COMPONENTS["sinks"]:
        credentials = [c for c in SCOPES[f"sinks/{typ}"].get("credentials", []) if c["shape"] == "aws"]
        if credentials:
            assert len(credentials) == 1, f"sinks/{typ}: more than one aws credential"
            # The rule holds only for the AWS strategy.
            assert credentials[0].get("when") == {"auth.strategy": ["aws"]}, f"sinks/{typ}: {credentials[0]}"
            found[typ] = credentials[0]["path"].split(".")
    return found


class AwsCredentialRules(unittest.TestCase):
    """A credentials file and the host's own AWS identity are refused whatever the host allows."""

    def test_the_four_sinks_and_where_each_reads_its_credential_match(self):
        # Measured with the pinned Vector: Elasticsearch flattens the credential
        # into auth, the shared HTTP authentication nests it in auth.auth.
        self.assertEqual(
            AGENT_AWS_PATHS,
            {
                "elasticsearch": ["auth"],
                "http": ["auth", "auth"],
                "loki": ["auth", "auth"],
                "prometheus_exporter": ["auth", "auth"],
            },
        )
        self.assertEqual(SERVER_AWS_PATHS, AGENT_AWS_PATHS)
        self.assertEqual(DASHBOARD_AWS_PATHS, AGENT_AWS_PATHS)
        self.assertLessEqual(set(AGENT_AWS_PATHS), set(AGENT_COMPONENTS["sinks"]))

    def test_the_keys_match(self):
        self.assertEqual(AGENT_AWS_KEYS["file"], ["credentials_file"])
        self.assertEqual(AGENT_AWS_KEYS["ambient"], ["assume_role", "imds", "profile"])
        # The agent demands both keys: one key alone leaves the rest to the host.
        self.assertEqual(AGENT_AWS_KEYS["explicit"], ["access_key_id", "secret_access_key"])
        self.assertEqual(SERVER_AWS_KEYS, AGENT_AWS_KEYS)
        self.assertEqual(DASHBOARD_AWS_KEYS, AGENT_AWS_KEYS)

    def test_every_component_is_judged_by_both_rules(self):
        self.assertIn("credentialRefusal(typ, c)", AGENT_COMPONENT)
        self.assertIn("credentials_file_below_auth(component, false)", SERVER_RULE)
        self.assertIn("signs_with_host_identity(typ, component)", SERVER_RULE)
        self.assertIn("credentialsFileBelowAuth(component)", DASHBOARD_RULE)
        self.assertIn("signsWithHostIdentity(component)", DASHBOARD_RULE)

    def test_the_rules_read_names_and_values_the_same_way(self):
        # A credentials file is a key below any auth key, in any case.
        self.assertIn("lower == credentialsFileKey", AGENT_FILE_FIELD)
        self.assertIn('belowAuth || lower == "auth"', AGENT_FILE_FIELD)
        self.assertIn("key == CREDENTIALS_FILE_KEY", SERVER_FILE_FIELD)
        self.assertIn('below_auth || key == "auth"', SERVER_FILE_FIELD)
        self.assertIn("lower === credentialsFileKey", DASHBOARD_FILE_FIELD)
        self.assertIn('belowAuth || lower === "auth"', DASHBOARD_FILE_FIELD)
        # The strategy is compared ignoring case.
        self.assertIn('strings.EqualFold(strategy, "aws")', AGENT_AMBIENT)
        self.assertIn('eq_ignore_ascii_case("aws")', SERVER_AMBIENT)
        self.assertIn('strategy.toLowerCase() !== "aws"', DASHBOARD_AMBIENT)
        # A key is a string with something other than space in it.
        self.assertIn('strings.TrimSpace(value) == ""', AGENT_EXPLICIT)
        self.assertIn("value.trim().is_empty()", SERVER_EXPLICIT)
        self.assertIn("blank.test(value)", DASHBOARD_EXPLICIT)
        # A role, a metadata client setting or a profile is set unless it is null or false.
        self.assertIn("value != nil && value != false", AGENT_EXPLICIT)
        self.assertIn("Value::Null | Value::Bool(false)", SERVER_EXPLICIT)
        self.assertIn("value == null", DASHBOARD_EXPLICIT)
        self.assertIn("value === false", DASHBOARD_EXPLICIT)

    def test_the_capability_table_agrees(self):
        aws = TABLE["credential_shapes"]["aws"]
        self.assertEqual(sorted(aws["ambient_keys"]), AGENT_AWS_KEYS["ambient"])
        self.assertEqual(sorted(aws["refused_keys"]), AGENT_AWS_KEYS["file"])
        # The table's list is looser (see the top of this file): every key it
        # counts as explicit is one the rule requires.
        self.assertTrue(aws["explicit"])
        self.assertLessEqual(set(aws["explicit"]), set(AGENT_AWS_KEYS["explicit"]))
        self.assertEqual(table_aws_paths(), AGENT_AWS_PATHS)


if __name__ == "__main__":
    unittest.main()
