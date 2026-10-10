import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('helper_notices', pathlib.Path(__file__).resolve().parent.parent / 'scripts/helper_notices.py')
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class RuntimeNotices(unittest.TestCase):
    def fixture(self, root):
        output = root / 'helper'
        output.mkdir()
        (output / 'collector.exe').write_bytes(b'original collector')
        (output / 'collector.py').write_bytes(b'original source')
        license_file = root / 'LICENSE.txt'
        license_file.write_bytes(b'Original Python copyright\r\nTerms\r\n')
        copying = root / 'COPYING.txt'
        copying.write_bytes(b'Original PyInstaller copying and exception\n')

        class Distribution:
            version = '6.22.3'
            files = [copying]

            @staticmethod
            def locate_file(file):
                return file
        return output, license_file, copying, Distribution()

    def test_original_bytes_versions_and_collector_identity_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            output, license_file, copying, dist = self.fixture(pathlib.Path(temp))
            record = notices.stage_runtime_notices(output, python_candidates=[license_file], distribution=dist, python_version='3.12.10', target_platform='win32')
            self.assertEqual((output / 'notices/cpython-license.txt').read_bytes(), license_file.read_bytes())
            self.assertEqual((output / 'notices/pyinstaller-copying.txt').read_bytes(), copying.read_bytes())
            self.assertEqual(json.loads((output / 'runtime-notices.json').read_text()), record)
            self.assertEqual(record['documents'][0]['version'], '3.12.10')
            self.assertFalse(record['completeBinarySbom'])

    def test_missing_or_empty_originals_fail_before_a_manifest_is_written(self):
        with tempfile.TemporaryDirectory() as temp:
            output, license_file, copying, dist = self.fixture(pathlib.Path(temp))
            with self.assertRaisesRegex(RuntimeError, 'Python license is missing'):
                notices.stage_runtime_notices(output, python_candidates=[], distribution=dist)
            copying.write_bytes(b'')
            with self.assertRaisesRegex(RuntimeError, 'notice is empty'):
                notices.stage_runtime_notices(output, python_candidates=[license_file], distribution=dist)
            copying.unlink()
            with self.assertRaisesRegex(RuntimeError, 'PyInstaller notice is missing'):
                notices.stage_runtime_notices(output, python_candidates=[license_file], distribution=dist)
            self.assertFalse((output / 'runtime-notices.json').exists())

    def test_unknown_prior_notice_is_not_silently_shipped_on_rebuild(self):
        with tempfile.TemporaryDirectory() as temp:
            output, license_file, copying, dist = self.fixture(pathlib.Path(temp))
            (output / 'notices').mkdir()
            (output / 'notices/foreign.txt').write_text('unexpected')
            with self.assertRaisesRegex(RuntimeError, 'Unexpected prior notice'):
                notices.stage_runtime_notices(output, python_candidates=[license_file], distribution=dist, target_platform='win32')


if __name__ == '__main__':
    unittest.main()
