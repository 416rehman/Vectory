"""license-inventory.py with synthetic CycloneDX documents."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('license_inventory', Path(__file__).with_name('license-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def sbom(*components):
    return {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'metadata': {'component': {'name': 'project'}}, 'components': list(components)}


class LicenseInventory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, document):
        path = self.root / name
        path.write_text(json.dumps(document), encoding='utf-8')
        return path

    def test_merges_ecosystems_and_license_shapes(self):
        rust = self.write('rust.cdx.json', sbom(
            {'name': 'serde', 'version': '1.0.0', 'purl': 'pkg:cargo/serde@1.0.0', 'licenses': [{'expression': 'MIT OR Apache-2.0'}]},
            {'name': 'ring', 'version': '0.17.0', 'purl': 'pkg:cargo/ring@0.17.0', 'licenses': [{'license': {'name': 'ISC AND OpenSSL'}}]},
        ))
        npm = self.write('npm.cdx.json', sbom(
            {'group': '@scope', 'name': 'pkg', 'version': '2.0.0', 'purl': 'pkg:npm/%40scope/pkg@2.0.0', 'licenses': [{'license': {'id': 'MIT'}}]},
            {'name': 'nested', 'version': '1.0.0', 'purl': 'pkg:npm/nested@1.0.0', 'components': [
                {'name': 'inner', 'version': '3.0.0', 'purl': 'pkg:npm/inner@3.0.0', 'licenses': [{'license': {'id': 'BSD-3-Clause'}}]},
            ]},
        ))
        rows = inventory.inventory([rust, npm])
        by_name = {r['name']: r for r in rows}
        self.assertEqual(by_name['serde']['licenses'], ['MIT OR Apache-2.0'])
        self.assertEqual(by_name['ring']['licenses'], ['ISC AND OpenSSL'])
        self.assertEqual(by_name['@scope/pkg']['ecosystem'], 'npm')
        self.assertEqual(by_name['inner']['licenses'], ['BSD-3-Clause'])
        self.assertEqual(by_name['nested']['licenses'], [])
        text = inventory.markdown(rows)
        self.assertIn('## Needs review (1)', text)
        self.assertIn('- npm nested 1.0.0: no license in its SBOM', text)
        self.assertIn('| cargo | serde | 1.0.0 | MIT OR Apache-2.0 |', text)

    def test_duplicates_merge_their_licenses(self):
        first = self.write('a.cdx.json', sbom({'name': 'x', 'version': '1', 'purl': 'pkg:golang/x@1', 'licenses': [{'license': {'id': 'MIT'}}]}))
        second = self.write('b.cdx.json', sbom({'name': 'x', 'version': '1', 'purl': 'pkg:golang/x@1'}))
        rows = inventory.inventory([first, second])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['licenses'], ['MIT'])

    def test_empty_or_foreign_documents_fail(self):
        with self.assertRaises(SystemExit):
            inventory.inventory([self.write('empty.cdx.json', sbom())])
        with self.assertRaises(SystemExit):
            inventory.inventory([self.write('spdx.json', {'spdxVersion': 'SPDX-2.3', 'packages': []})])


if __name__ == '__main__':
    unittest.main()
