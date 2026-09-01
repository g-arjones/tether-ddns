"""Tests for the incident domain model and helpers."""
from typing import Callable

from tether_ddns.incidents import (
    Incident,
    IncidentWindow,
    classify,
    failed_ips,
    prune,
)
from tether_ddns.reachability import ReachabilityResult

ResultFactory = Callable[[list[bool]], ReachabilityResult]


def test_classify_all_ok_is_healthy(make_result: ResultFactory) -> None:
    """A check where every probe succeeded yields no incident."""
    assert classify(make_result([True, True, True])) is None


def test_classify_partial_failure_is_degraded(make_result: ResultFactory) -> None:
    """A check that lost two probes but held quorum is degraded."""
    assert classify(make_result([True, False, False])) == 'degraded'


def test_classify_single_failure_is_healthy(make_result: ResultFactory) -> None:
    """A check that lost only one probe but held quorum is healthy."""
    assert classify(make_result([True, True, False])) is None


def test_classify_total_failure_is_outage(make_result: ResultFactory) -> None:
    """A check where every probe failed is an outage."""
    assert classify(make_result([False, False, False])) == 'outage'


def test_failed_ips_lists_only_failures(make_result: ResultFactory) -> None:
    """failed_ips returns the IPs of probes that did not succeed."""
    result = make_result([True, False, False])
    assert failed_ips(result) == ['10.0.0.1', '10.0.0.2']


def test_prune_drops_fully_expired_incidents() -> None:
    """An incident that ended before the cutoff is dropped."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=10.0, end=20.0, severity='outage',
            min_successes=0, total=3, failed=[])])
    assert prune(window, 30.0) is True
    assert window.incidents == []


def test_prune_keeps_incident_overlapping_the_cutoff() -> None:
    """An incident that started before but ended after the cutoff stays."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=10.0, end=40.0, severity='outage',
            min_successes=0, total=3, failed=[])])
    assert prune(window, 30.0) is False
    assert len(window.incidents) == 1


def test_prune_reports_no_change_when_nothing_expired() -> None:
    """Prune returns False when every incident is inside the window."""
    window = IncidentWindow(
        monitoring_since=0.0, rev=0, ongoing=None,
        incidents=[Incident(
            start=100.0, end=110.0, severity='degraded',
            min_successes=2, total=3, failed=[])])
    assert prune(window, 30.0) is False
