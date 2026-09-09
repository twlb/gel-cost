"""Manual workflow contract tests; no live token, GitHub or source requests."""
import base64
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import outage_actions as actions
import outage_checkpoint as checkpoint
from outage_state_store import FileState, GitState, StateError
import refresh_outages as refresh
from test_outages_refresh import NOW, fixture


class ManualActionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.output = self.base/'outages.json'
        self.private = self.base/'private'
        refresh.initialize(self.private, self.output, now=NOW)
        self.store = FileState(self.private)
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                    'GITHUB_REPOSITORY': 'twlb/gel-cost', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_SERVER_URL': 'https://github.com',
                    'OUTAGE_GITHUB_TOKEN': 'SYNTHETIC_TEST_TOKEN'}

    def test_default_mode_is_inspect_and_requires_trusted_context(self):
        self.assertEqual(actions.context(self.env)[0], 'inspect')
        for key, value in [('GITHUB_EVENT_NAME', 'push'), ('GITHUB_REF', 'refs/heads/test'),
                           ('GITHUB_ACTIONS', 'false'), ('GITHUB_REPOSITORY', 'someone/else'),
                           ('GITHUB_SERVER_URL', 'http://other.invalid'), ('OUTAGE_MODE', 'initialize'),
                           ('OUTAGE_GITHUB_TOKEN', '')]:
            with self.subTest(key=key):
                with self.assertRaises(StateError):
                    actions.context({**self.env, key: value})

    def test_collection_requires_enablement_and_per_run_consent(self):
        for enabled, consent in [('', ''), ('true', ''), ('', 'true'), ('false', 'true')]:
            with self.assertRaises(StateError):
                actions.context({**self.env, 'OUTAGE_MODE': 'collect',
                                 'OUTAGE_COLLECTION_ENABLED': enabled, 'OUTAGE_CONFIRM_COLLECTION': consent})
        self.assertEqual(actions.context({**self.env, 'OUTAGE_MODE': 'collect',
                         'OUTAGE_COLLECTION_ENABLED': 'true', 'OUTAGE_CONFIRM_COLLECTION': 'true'})[0], 'collect')

    def test_inspection_never_calls_source_saves_state_or_changes_feed(self):
        refresh.run(self.private, self.output, now=NOW, fetcher=fixture)
        before = self.output.read_bytes()
        revision = self.store.read()[0]
        self.store.save = Mock(side_effect=AssertionError('inspection must not save'))
        fetcher = Mock(side_effect=AssertionError('inspection must not fetch'))
        result = actions.run(self.store, 'inspect', self.output, NOW+timedelta(hours=3), fetcher=fetcher)
        self.assertEqual(result['state'], 'ready_for_manual_collection')
        self.assertFalse(result['sitePublished'])
        self.assertEqual(self.output.read_bytes(), before)
        self.assertEqual(self.store.read()[0], revision)
        fetcher.assert_not_called()
        self.store.save.assert_not_called()

    def test_missing_state_is_reported_without_initialization(self):
        store = Mock()
        store.read.return_value = (None, None)
        result = actions.run(store, 'inspect', self.output, NOW)
        self.assertEqual(result['state'], 'missing_state_requires_review')
        store.save.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_inspection_reports_blocked_interrupted_and_paused_states(self):
        revision, raw = self.store.read()
        original = checkpoint.decode(raw, NOW)
        for field, value, expected in [('blocked', True, 'blocked_requires_review'),
                                        ('inFlight', True, 'interrupted_requires_review'),
                                        ('nextAttemptAt', '2026-09-09T10:00:00Z', 'not_due')]:
            data = json.loads(json.dumps(original))
            data['endpoint'][field] = value
            revision = self.store.save(data, revision)
            self.assertEqual(actions.run(self.store, 'inspect', self.output, NOW)['state'], expected)

    def test_collection_updates_state_but_preserves_site_file_byte_for_byte(self):
        refresh.run(self.private, self.output, now=NOW, fetcher=fixture)
        before = self.output.read_bytes()
        def updated(now, *, centre):
            payload = fixture(now, centre=centre)
            payload['data'][0]['reconnectionDate'] = '2026-09-09 16:00'
            return payload
        result = actions.run(self.store, 'collect', self.output, NOW+timedelta(hours=3), fetcher=updated)
        self.assertEqual(result['state'], 'collected')
        self.assertFalse(result['sitePublished'])
        self.assertEqual(before, self.output.read_bytes())
        state = checkpoint.decode(self.store.read()[1], NOW+timedelta(hours=3))
        self.assertEqual(state['snapshots']['batumi']['events'][0]['endLocal'], '2026-09-09 16:00')

    def test_inspection_rejects_corrupt_state(self):
        self.store.path.write_bytes(b'{}')
        with self.assertRaises(ValueError):
            actions.run(self.store, 'inspect', self.output, NOW)

    def test_cli_outside_actions_does_not_try_to_authenticate(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(actions, 'GitState') as git:
            with self.assertRaises(StateError):
                actions.main()
            git.assert_not_called()


class ScopedGitAuthTests(unittest.TestCase):
    def test_token_only_in_scoped_process_environment_not_args_or_disk(self):
        token = 'SYNTHETIC_ONLY_TOKEN'
        remote = 'https://github.com/twlb/gel-cost.git'
        with patch('outage_state_store.subprocess.run', return_value=SimpleNamespace(stdout=b'')) as call:
            with patch.dict(os.environ, {'GIT_TRACE': '1', 'OUTAGE_GITHUB_TOKEN': token}):
                with GitState(remote, token=token) as store:
                    store._git('ls-remote', '--refs', remote)
                    self.assertEqual(list(store.directory.iterdir()), [])
                    args, kwargs = call.call_args
                    self.assertNotIn(token, ' '.join(args[0]))
                    env = kwargs['env']
                    self.assertNotIn('GIT_TRACE', env)
                    self.assertNotIn('OUTAGE_GITHUB_TOKEN', env)
                    self.assertEqual(env['GIT_CONFIG_KEY_0'], f'http.{remote}.extraHeader')
                    expected = base64.b64encode(('x-access-token:'+token).encode()).decode()
                    self.assertEqual(env['GIT_CONFIG_VALUE_0'], 'AUTHORIZATION: basic '+expected)
                    self.assertEqual(env['GIT_CONFIG_VALUE_1'], 'false')
                    self.assertEqual(env['GIT_CONFIG_VALUE_2'], 'true')
                    self.assertEqual(env['GIT_CONFIG_GLOBAL'], os.devnull)

    def test_token_cannot_be_forwarded_to_other_origins_or_insecure_urls(self):
        for remote in ['http://github.com/twlb/gel-cost.git', 'https://github.com.evil.test/x/r.git',
                       'https://user@github.com/twlb/gel-cost.git', 'https://github.com/twlb/gel-cost.git?x=1',
                       '/tmp/remote.git']:
            with self.assertRaises(StateError):
                GitState(remote, token='SYNTHETIC')

    def test_transport_error_does_not_print_token(self):
        with patch('outage_state_store.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'git', stderr=b'SYNTHETIC_TOKEN')):
            with self.assertRaisesRegex(StateError, '^state_transport_failed_requires_review$'):
                GitState('https://github.com/twlb/gel-cost.git', token='SYNTHETIC_TOKEN')


class WorkflowContractTests(unittest.TestCase):
    def test_manual_workflow_has_no_schedule_deployment_or_raw_artifacts(self):
        # Ruby's standard-library parser avoids adding a Python dependency.
        path = refresh.REPO/'.github/workflows/check-outages.yml'
        parsed = subprocess.run(['ruby', '-ryaml', '-rjson', '-e',
            'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', str(path)],
            capture_output=True, text=True, check=True)
        workflow = json.loads(parsed.stdout)
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        self.assertEqual(workflow['on']['workflow_dispatch']['inputs']['mode']['default'], 'inspect')
        self.assertIs(workflow['on']['workflow_dispatch']['inputs']['confirm_collection']['default'], False)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertIs(workflow['concurrency']['cancel-in-progress'], False)
        self.assertEqual(workflow['jobs']['collect']['permissions'], {'contents': 'write'})
        for job in workflow['jobs'].values():
            self.assertIn("github.ref == 'refs/heads/main'", job['if'])
            for step in job['steps']:
                if 'uses' in step:
                    self.assertRegex(step['uses'], r'^actions/checkout@[0-9a-f]{40}$')
                    self.assertIs(step['with']['persist-credentials'], False)
                if 'run' in step:
                    subprocess.run(['bash', '-n'], input=step['run'], text=True, check=True)
                    self.assertNotIn('${{', step['run'])
        raw = path.read_text()
        for forbidden in ('schedule:', 'pages: write', 'upload-artifact', 'actions/cache', '--initialize', 'git push'):
            self.assertNotIn(forbidden, raw)

    def test_collect_shell_gate_refuses_missing_opt_in(self):
        path = refresh.REPO/'.github/workflows/check-outages.yml'
        parsed = subprocess.run(['ruby', '-ryaml', '-rjson', '-e',
            'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', str(path)],
            capture_output=True, text=True, check=True)
        script = json.loads(parsed.stdout)['jobs']['collect']['steps'][0]['run']
        for enabled, confirmed, code in [('', '', 1), ('true', '', 1), ('', 'true', 1), ('true', 'true', 0)]:
            result = subprocess.run(['bash', '-e', '-c', script], env={**os.environ, 'ENABLED': enabled, 'CONFIRMED': confirmed}, capture_output=True)
            self.assertEqual(result.returncode, code)
