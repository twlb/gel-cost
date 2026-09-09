"""Checkpoint stores with compare-and-swap. Git writes only a fixed state ref.

No workflow calls this yet. GitState uses a disposable bare repo, not the app's
checkout/index. No automatic branch initialization or retries after failed push.
"""
import base64
import hashlib
import os
import re
from pathlib import Path
import subprocess
import tempfile
import uuid

import outage_checkpoint as checkpoint
import collect_power_pilot as power

REF = 'refs/heads/outage-collector-state'
FILE = 'checkpoint.json'


class StateError(ValueError):
    pass


class FileState:
    # The caller holds a directory-wide flock for the entire run.
    def __init__(self, directory):
        self.path = Path(directory) / FILE

    def read(self):
        try:
            with self.path.open('rb') as stream:
                raw = stream.read(checkpoint.MAX_BYTES + 1)
            if len(raw) > checkpoint.MAX_BYTES:
                raise StateError('state_too_large')
            return hashlib.sha256(raw).hexdigest(), raw
        except FileNotFoundError:
            return None, None

    def save(self, value, expected):
        if self.read()[0] != expected:
            raise StateError('state_changed_requires_review')
        raw = checkpoint.encode(value)
        checkpoint.decode(raw, now=power.read_stamp(value['updatedAt']))
        power.write_atomic(self.path, value)
        return self.read()[0]


class GitState:
    def __init__(self, remote, *, token=None):
        # remote is operator configuration, never derived from source data.
        if not isinstance(remote, str) or not remote or remote.startswith('-'):
            raise StateError('invalid_state_remote')
        if token is not None and (not isinstance(token, str) or not token or
                any(ord(char) < 33 or ord(char) > 126 for char in token) or
                not re.fullmatch(r'https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\.git', remote)):
            raise StateError('invalid_authenticated_state_remote')
        self.remote = remote
        self._token = token
        self.tmp = tempfile.TemporaryDirectory(prefix='gamarji-state-git-')
        self.directory = Path(self.tmp.name)
        try:
            self._git('init', '--bare', '--quiet', str(self.directory))
        except BaseException:
            self.tmp.cleanup()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.tmp.cleanup()

    def _git(self, *args, data=None):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('GIT_') and key not in ('OUTAGE_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN')}
        env.update({'GIT_TERMINAL_PROMPT': '0', 'GIT_AUTHOR_NAME': 'Gamarji collector',
                    'GIT_AUTHOR_EMAIL': 'collector@invalid.local',
                    'GIT_COMMITTER_NAME': 'Gamarji collector',
                    'GIT_COMMITTER_EMAIL': 'collector@invalid.local',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
        if self._token is not None:
            # Token is neither a CLI argument, a remote URL nor an on-disk Git
            # setting. Scope its header to the one approved HTTPS repository.
            header = base64.b64encode(('x-access-token:' + self._token).encode()).decode()
            config = [(f'http.{self.remote}.extraHeader', 'AUTHORIZATION: basic ' + header),
                      ('http.followRedirects', 'false'), ('http.sslVerify', 'true'),
                      ('credential.helper', '')]
            env['GIT_CONFIG_COUNT'] = str(len(config))
            for index, (key, value) in enumerate(config):
                env[f'GIT_CONFIG_KEY_{index}'] = key
                env[f'GIT_CONFIG_VALUE_{index}'] = value
        try:
            return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null',
                                   '-c', 'protocol.ext.allow=never', '-C', str(self.directory), *args],
                                  input=data, capture_output=True, check=True, timeout=45, env=env).stdout
        except (subprocess.SubprocessError, OSError) as exc:
            # Git output may contain configured URLs/credentials. Never echo it.
            raise StateError('state_transport_failed_requires_review') from exc

    def read(self):
        listing = self._git('ls-remote', '--refs', self.remote, REF).splitlines()
        if not listing:
            return None, None
        if len(listing) != 1 or listing[0].split()[1] != REF.encode():
            raise StateError('unexpected_state_ref')
        self._git('fetch', '--quiet', '--no-tags', '--depth=1', self.remote, REF)
        revision = self._git('rev-parse', 'FETCH_HEAD').decode().strip()
        tree = self._git('ls-tree', revision).decode().strip().split()
        if len(tree) != 4 or tree[0:2] != ['100644', 'blob'] or tree[3] != FILE:
            raise StateError('unexpected_state_tree')
        size = int(self._git('cat-file', '-s', tree[2]))
        if size > checkpoint.MAX_BYTES:
            raise StateError('state_too_large')
        return revision, self._git('cat-file', 'blob', tree[2])

    def save(self, value, expected):
        raw = checkpoint.encode(value)
        checkpoint.decode(raw, now=power.read_stamp(value['updatedAt']))
        blob = self._git('hash-object', '-w', '--stdin', data=raw).decode().strip()
        tree = self._git('mktree', data=f'100644 blob {blob}\t{FILE}\n'.encode()).decode().strip()
        parent = ['-p', expected] if expected else []
        # Unique commits prevent identical concurrent reservations from succeeding.
        revision = self._git('commit-tree', tree, *parent,
                             data=f'Collector checkpoint {uuid.uuid4()}\n'.encode()).decode().strip()
        # Exact lease is CAS, including branch absence for explicit initialization.
        # The new commit ALWAYS has expected as its parent: no history rewrite.
        self._git('push', '--quiet', f'--force-with-lease={REF}:{expected or ""}',
                  self.remote, f'{revision}:{REF}')
        return revision
