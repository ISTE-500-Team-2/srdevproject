"""Run the Dockerfile's actual cached-build command against stale timestamp input.

Real TypeScript, disposable project, no network, Docker, API or live records.
"""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TypeCacheTests(unittest.TestCase):
    def test_warm_cache_cannot_hide_type_errors_with_older_source_timestamps(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        instruction = re.search(r'RUN --mount=type=cache,[^\n]*\\\n([^\n]+)', dockerfile)
        self.assertIsNotNone(instruction, 'Expected the checked frontend cache build instruction')
        command = instruction.group(1).strip()
        compiler = ROOT / 'frontend/node_modules/typescript/bin/tsc'
        self.assertTrue(compiler.is_file(), 'Install frontend dependencies first')
        with tempfile.TemporaryDirectory(prefix='arbor-type-cache-') as temporary:
            fixture = Path(temporary); frontend = fixture / 'frontend'
            src = frontend / 'src'; src.mkdir(parents=True)
            file = src / 'fixture.ts'; file.write_text('export const count: number = 1;\n')
            (frontend / 'vite.config.ts').write_text('export {};\n')
            (frontend / 'package.json').write_text(json.dumps({'private': True, 'scripts': {
                'build': 'node ' + shlex.quote(str(compiler)) + ' -b'}}))
            (frontend / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {
                'incremental': True, 'tsBuildInfoFile': '.tsbuild-cache/app.tsbuildinfo',
                'strict': True, 'noEmit': True, 'skipLibCheck': True, 'types': []}, 'include': ['src']}))
            def build():
                return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command],
                                      cwd=fixture, capture_output=True, text=True, timeout=60)
            result = build(); self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((frontend / '.tsbuild-cache/app.tsbuildinfo').is_file())
            file.write_text('export const count: number = "must fail";\n')
            os.utime(file, (946684800, 946684800))
            result = build()
            self.assertNotEqual(result.returncode, 0, 'A warm graph incorrectly accepted changed invalid source')
            self.assertIn('TS2322', result.stdout)
            file.write_text('export const count: number = 2;\n')
            os.utime(file, (946684800, 946684800))
            result = build(); self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
