"""Tests for the IncidentRecorder transition table and write policy."""
import time
from pathlib import Path
from typing import Callable
from unittest.mock import patch

from tether_ddns.incident_store import IncidentStore
from tether_ddns.incidents import (
    Incident,
    IncidentWindow,
    WINDOW_SECONDS,
)
from tether_ddns.reachability import ReachabilityResult
from tether_ddns.services.incidents import IncidentRecorder

HEALTHY = [True, True, False]
DEGRADED = [True, False, False]
OUTAGE = [False, False, False]

ResultFactory = Callable[[list[bool]], ReachabilityResult]


def test_healthy_checks_open_no_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A run of healthy checks leaves the window empty."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    view = recorder.view  # Initialize to satisfy pyright
    for tick in range(5):
        view = recorder.record(make_result(HEALTHY), now=float(tick))
    assert view.ongoing is None
    assert recorder.window(now=10.0).incidents == []


def test_first_bad_check_opens_an_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The first non-healthy check opens an ongoing incident."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    view = recorder.record(make_result(OUTAGE), now=100.0)
    assert view.ongoing is not None
    assert view.ongoing.severity == 'outage'
    assert view.ongoing.start == 100.0
    assert view.ongoing.end is None


def test_same_severity_checks_extend_one_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Consecutive checks at the same severity merge into one span."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    recorder.record(make_result(OUTAGE), now=100.0)
    recorder.record(make_result(OUTAGE), now=130.0)
    view = recorder.record(make_result(HEALTHY), now=160.0)
    window = recorder.window(now=200.0)
    assert view.ongoing is None
    assert len(window.incidents) == 1
    assert window.incidents[0].start == 100.0
    assert window.incidents[0].end == 160.0


def test_severity_change_splits_into_contiguous_spans(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A severity change closes one incident and opens the next at the same instant."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    recorder.record(make_result(DEGRADED), now=100.0)
    recorder.record(make_result(OUTAGE), now=130.0)
    recorder.record(make_result(HEALTHY), now=160.0)
    window = recorder.window(now=200.0)
    assert [i.severity for i in window.incidents] == ['degraded', 'outage']
    assert window.incidents[0].end == 130.0
    assert window.incidents[1].start == 130.0


def test_incident_records_worst_quorum_and_failed_resolvers(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """An incident keeps the worst quorum and the union of failed resolvers."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    # Severity pins the success count, so only the failed set differs across a span.
    recorder.record(make_result([True, False, False]), now=100.0)
    recorder.record(make_result([False, True, False]), now=130.0)
    recorder.record(make_result(HEALTHY), now=160.0)
    incident = recorder.window(now=200.0).incidents[0]
    assert incident.min_successes == 1
    assert incident.failed == ['10.0.0.0', '10.0.0.1', '10.0.0.2']


def test_no_disk_writes_while_healthy_or_steady(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Disk writes happen only on open, close, split and prune."""
    store = IncidentStore(tmp_path / 'i.json')
    recorder = IncidentRecorder(store)
    with patch.object(store, 'save', wraps=store.save) as save:
        recorder.record(make_result(HEALTHY), now=100.0)
        recorder.record(make_result(HEALTHY), now=130.0)
        assert save.call_count == 0, 'healthy checks must not write'

        recorder.record(make_result(OUTAGE), now=160.0)
        assert save.call_count == 1, 'opening an incident writes once'

        recorder.record(make_result(OUTAGE), now=190.0)
        recorder.record(make_result(OUTAGE), now=220.0)
        assert save.call_count == 1, 'a steady incident must not write'

        recorder.record(make_result(DEGRADED), now=250.0)
        assert save.call_count == 2, 'a severity split writes once'

        recorder.record(make_result(HEALTHY), now=280.0)
        assert save.call_count == 3, 'closing an incident writes once'

        recorder.record(make_result(HEALTHY), now=310.0)
        assert save.call_count == 3, 'healthy checks after close must not write'


def test_prune_writes_only_when_a_record_expires(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A tick prunes and writes only when an incident actually falls out."""
    path = tmp_path / 'i.json'
    end = time.time() - WINDOW_SECONDS / 2
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=end - 110, rev=1, ongoing=None,
        incidents=[Incident(
            start=end - 100, end=end, severity='outage',
            min_successes=0, total=3, failed=[])]))
    store = IncidentStore(path)
    recorder = IncidentRecorder(store)
    with patch.object(store, 'save', wraps=store.save) as save:
        recorder.record(make_result(HEALTHY), now=end + 100)
        assert save.call_count == 0
        recorder.record(make_result(HEALTHY), now=end + WINDOW_SECONDS + 1)
        assert save.call_count == 1
    assert recorder.window(now=end + WINDOW_SECONDS + 1).incidents == []


def test_rev_is_stable_across_healthy_checks(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The revision counter does not move on a healthy tick."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    first = recorder.record(make_result(HEALTHY), now=100.0).rev
    second = recorder.record(make_result(HEALTHY), now=130.0).rev
    assert first == second


def test_rev_advances_on_open_and_close(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The revision counter advances on each real mutation."""
    recorder = IncidentRecorder(IncidentStore(tmp_path / 'i.json'))
    opened = recorder.record(make_result(OUTAGE), now=100.0).rev
    steady = recorder.record(make_result(OUTAGE), now=130.0).rev
    closed = recorder.record(make_result(HEALTHY), now=160.0).rev
    assert steady == opened
    assert closed > opened


def test_restart_closes_ongoing_at_first_healthy_check(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """An incident in flight when the process died ends at the first check back."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=3, incidents=[],
        ongoing=Incident(
            start=100.0, end=None, severity='outage',
            min_successes=0, total=3, failed=['10.0.0.1'])))
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result(HEALTHY), now=5000.0)
    window = recorder.window(now=5000.0)
    assert window.ongoing is None
    assert window.incidents[0].start == 100.0
    assert window.incidents[0].end == 5000.0


def test_restart_extends_ongoing_at_same_severity(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """A still-failing check after restart extends the persisted incident."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=3, incidents=[],
        ongoing=Incident(
            start=100.0, end=None, severity='outage',
            min_successes=1, total=3, failed=['10.0.0.1'])))
    recorder = IncidentRecorder(IncidentStore(path))
    view = recorder.record(make_result(OUTAGE), now=5000.0)
    assert view.ongoing is not None
    assert view.ongoing.start == 100.0


def test_prune_on_load_writes_when_records_expire(tmp_path: Path) -> None:
    """Loading a stale file prunes it and rewrites immediately."""
    path = tmp_path / 'i.json'
    IncidentStore(path).save(IncidentWindow(
        monitoring_since=0.0, rev=1, ongoing=None,
        incidents=[Incident(
            start=1.0, end=2.0, severity='outage',
            min_successes=0, total=3, failed=[])]))
    recorder = IncidentRecorder(IncidentStore(path))
    assert recorder.window().incidents == []
    assert IncidentStore(path).load().incidents == []


def test_first_start_persists_monitoring_since(tmp_path: Path) -> None:
    """First-ever start writes the file so monitoring_since is stable."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    assert path.exists()
    since = recorder.window().monitoring_since
    restarted = IncidentRecorder(IncidentStore(path))
    assert restarted.window().monitoring_since == since


def test_later_starts_do_not_rewrite_the_file(tmp_path: Path) -> None:
    """Starting against an existing, current file writes nothing."""
    path = tmp_path / 'i.json'
    IncidentRecorder(IncidentStore(path))
    store = IncidentStore(path)
    with patch.object(store, 'save') as save:
        IncidentRecorder(store)
        assert save.call_count == 0


def test_flush_persists_widening_of_a_steady_incident(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Flush writes the in-memory widening that a steady tick skipped."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result([True, False, False]), now=100.0)
    recorder.record(make_result([False, True, False]), now=130.0)
    recorder.flush()
    ongoing = IncidentStore(path).load().ongoing
    assert ongoing is not None
    assert ongoing.failed == ['10.0.0.0', '10.0.0.1', '10.0.0.2']


def test_flush_is_a_no_op_when_nothing_changed(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """Flush does not write when no widening is pending."""
    store = IncidentStore(tmp_path / 'i.json')
    recorder = IncidentRecorder(store)
    recorder.record(make_result(HEALTHY), now=100.0)
    with patch.object(store, 'save') as save:
        recorder.flush()
        assert save.call_count == 0


def test_window_filters_expired_records_on_read(
    tmp_path: Path, make_result: ResultFactory
) -> None:
    """The served window excludes records outside the retention period."""
    path = tmp_path / 'i.json'
    recorder = IncidentRecorder(IncidentStore(path))
    recorder.record(make_result(OUTAGE), now=100.0)
    recorder.record(make_result(HEALTHY), now=200.0)
    later = 200.0 + WINDOW_SECONDS + 1
    assert recorder.window(now=later).incidents == []
