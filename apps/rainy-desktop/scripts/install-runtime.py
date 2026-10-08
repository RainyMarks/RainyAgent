"""Verify and unpack the downloaded Host into Rainy's private WSL directory."""
import fcntl
import hashlib
import json
from pathlib import Path
import os
import sys
import tarfile
import tempfile

archive = Path(sys.argv[1]).resolve()
metadata = json.loads(Path(sys.argv[2]).read_text())
digest = metadata['sha256']
if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
    raise RuntimeError('Invalid Rainy runtime digest')
owned = Path.home() / '.rainy-agent/runtime'
owned.mkdir(mode=0o700, parents=True, exist_ok=True)
target = owned / digest
with (owned / '.install.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if not (target / '.complete').is_file():
        if target.exists():
            raise RuntimeError('Incomplete runtime directory; preserved for diagnosis')
        # The carrier downloads the archive only when this version's runtime is not installed yet;
        # an archive left by an earlier version is replaced the same way.
        if not archive.is_file() or archive.stat().st_size != metadata['bytes'] or (
                hashlib.sha256(archive.read_bytes()).hexdigest() != digest):
            print(json.dumps({'needsArchive': True}))
            sys.exit(0)
        staging = Path(tempfile.mkdtemp(prefix='.install-', dir=owned))
        with tarfile.open(archive, 'r:gz') as package:
            package.extractall(staging, filter='data')
        if not (staging / 'node/bin/node').is_file() or not (staging / 'app/lib/host.js').is_file():
            raise RuntimeError('Rainy runtime is missing its executable')
        (staging / '.complete').write_text(digest + '\n')
        staging.rename(target)
print(json.dumps({'node': str(target / 'node/bin/node'), 'host': str(target / 'app/lib/host.js')}))
