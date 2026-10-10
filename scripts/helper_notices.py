"""Preserve original notices from the runtime that actually builds the collector."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import sysconfig


def stage_runtime_notices(output, *, python_candidates=None, distribution=None,
                          python_version=None, target_platform=None):
    output = Path(output)
    python_version = python_version or platform.python_version()
    target_platform = target_platform or sys.platform
    candidates = python_candidates if python_candidates is not None else [
        Path(sys.base_prefix) / 'LICENSE.txt',
        Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt',
    ]
    python_license = next((Path(p) for p in candidates if Path(p).is_file()), None)
    if python_license is None:
        raise RuntimeError('Original build-runtime Python license is missing')
    distribution = distribution or importlib.metadata.distribution('pyinstaller')
    copying = next((distribution.locate_file(p) for p in (distribution.files or [])
                    if p.name == 'COPYING.txt' and distribution.locate_file(p).is_file()), None)
    if copying is None:
        raise RuntimeError('Original installed PyInstaller notice is missing')
    sources = [
        ('cpython-license.txt', 'CPython', python_version, python_license),
        ('pyinstaller-copying.txt', 'PyInstaller', distribution.version, Path(copying)),
    ]
    documents = []
    contents = {}
    for name, component, version, source in sources:
        if source.is_symlink():
            raise RuntimeError('Notice source must be an original regular file')
        content = source.read_bytes()
        if not content.strip():
            raise RuntimeError('Original runtime notice is empty')
        contents[name] = content
        documents.append(dict(name=name, component=component, version=version,
                              bytes=len(content), sha256=hashlib.sha256(content).hexdigest()))
    executable = 'collector.exe' if target_platform == 'win32' else 'collector'
    manifest = dict(schema=1, pythonVersion=python_version,
                    pyInstallerVersion=distribution.version, platform=target_platform,
                    collectorSha256=hashlib.sha256((output / executable).read_bytes()).hexdigest(),
                    collectorSourceSha256=hashlib.sha256((output / 'collector.py').read_bytes()).hexdigest(),
                    documents=documents, completeBinarySbom=False,
                    limits='Original runtime notices and exact collector identity only; embedded dependency coverage and provider eligibility are not established.')
    notices = output / 'notices'
    notices.mkdir(exist_ok=True)
    if notices.is_symlink():
        raise RuntimeError('Notice destination must be an owned regular directory')
    if set(p.name for p in notices.iterdir()) - set(contents):
        raise RuntimeError('Unexpected prior notice file; inspect before rebuilding')
    for name, content in contents.items():
        target = notices / name
        if target.is_symlink():
            raise RuntimeError('Notice destination must be an owned regular file')
        target.write_bytes(content)
    (output / 'runtime-notices.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest
