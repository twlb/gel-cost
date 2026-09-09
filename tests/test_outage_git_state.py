"""Real Git integration against disposable local bare repositories. No network."""
from datetime import timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import outage_checkpoint as checkpoint
from outage_state_store import GitState, StateError, REF
import refresh_outages as refresh
import collect_power_pilot as power
from test_outages_refresh import NOW, fixture


class GitStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.remote = str(self.base / 'remote.git')
        subprocess.run(['git', 'init', '--quiet', '--bare', self.remote], check=True, capture_output=True)
        self.output = self.base / 'outages.json'
        with GitState(self.remote) as store:
            refresh.initialize_store(store, self.output, NOW)

    def test_new_runner_restores_history_and_pause(self):
        with GitState(self.remote) as first:
            self.assertEqual(refresh.collect(first, self.output, NOW, fixture)['events'], 1)
        before = self.output.read_bytes()
        with GitState(self.remote) as second:
            self.assertEqual(refresh.collect(second, self.output, NOW, Mock())['state'], 'not_due')
            def fail(now, **kw):
                raise power.SourceFailure('network_or_tls_error')
            result = refresh.collect(second, self.output, NOW+timedelta(hours=3), fail)
            self.assertEqual(result['events'], 1)
            state = checkpoint.decode(second.read()[1], NOW+timedelta(hours=3))
            self.assertEqual(state['snapshots']['batumi']['collection']['lastSuccessAt'], power.stamp(NOW))
        self.assertIn(b'energo:', before)

    def test_403_survives_destruction_of_runner(self):
        def forbidden(now, **kwargs):
            raise power.SourceFailure('http_403', blocked=True)
        with GitState(self.remote) as first:
            self.assertEqual(refresh.collect(first, self.output, NOW, forbidden)['requests'], 1)
        with GitState(self.remote) as second:
            fetcher = Mock()
            self.assertEqual(refresh.collect(second, self.output, NOW+timedelta(days=1), fetcher)['state'], 'blocked_requires_review')
            fetcher.assert_not_called()

    def test_retry_after_survives_destruction_of_runner(self):
        def paused(now, **kwargs):
            raise power.SourceFailure('http_429', retry_after=power.stamp(NOW+timedelta(hours=5)))
        with GitState(self.remote) as first:
            self.assertEqual(refresh.collect(first, self.output, NOW, paused)['requests'], 1)
        with GitState(self.remote) as second:
            fetcher = Mock()
            self.assertEqual(refresh.collect(second, self.output, NOW+timedelta(hours=3), fetcher)['state'], 'not_due')
            fetcher.assert_not_called()

    def test_racing_reservations_allow_only_one_writer(self):
        with GitState(self.remote) as first, GitState(self.remote) as second:
            revision, raw = first.read()
            other_revision, _ = second.read()
            self.assertEqual(revision, other_revision)
            value = checkpoint.decode(raw, NOW)
            value['endpoint']['inFlight'] = True
            saved = first.save(value, revision)
            # Identical JSON and same-second commits still have distinct IDs.
            with self.assertRaises(StateError):
                second.save(value, other_revision)
            self.assertEqual(first.read()[0], saved)

    def test_missing_remote_state_does_not_bootstrap_on_fetch(self):
        empty = str(self.base / 'empty.git')
        subprocess.run(['git', 'init', '--quiet', '--bare', empty], check=True, capture_output=True)
        with GitState(empty) as store:
            fetcher = Mock()
            with self.assertRaisesRegex(StateError, 'missing_state'):
                refresh.collect(store, self.output, NOW, fetcher)
            fetcher.assert_not_called()
            self.assertIsNone(store.read()[0])

    def test_state_branch_contains_only_checkpoint(self):
        with GitState(self.remote) as store:
            refresh.collect(store, self.output, NOW, fixture)
        tree = subprocess.run(['git', '--git-dir', self.remote, 'ls-tree', '--name-only', REF],
                              check=True, capture_output=True, text=True).stdout.strip()
        refs = subprocess.run(['git', '--git-dir', self.remote, 'for-each-ref', '--format=%(refname)'],
                              check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(tree, 'checkpoint.json')
        self.assertEqual(refs, REF)

    def test_remote_failure_is_not_missing_state(self):
        with GitState(str(self.base / 'does-not-exist.git')) as store:
            with self.assertRaises(StateError):
                store.read()

    def test_existing_branch_cannot_be_reinitialized(self):
        with GitState(self.remote) as first, GitState(self.remote) as second:
            revision, raw = first.read()
            value = checkpoint.decode(raw, NOW)
            with self.assertRaises(StateError):
                second.save(value, None)
            self.assertEqual(first.read()[0], revision)

    def test_losing_concurrent_runner_never_queries_source(self):
        with GitState(self.remote) as first, GitState(self.remote) as second:
            revision, raw = second.read()
            value = checkpoint.decode(raw, NOW)
            value['endpoint']['inFlight'] = True
            # Simulate second runner having read just before the reservation.
            first.read()
            first.save(value, revision)
            second.read = Mock(return_value=(revision, raw))
            fetcher = Mock()
            with self.assertRaises(StateError):
                refresh.collect(second, self.output, NOW, fetcher)
            fetcher.assert_not_called()
