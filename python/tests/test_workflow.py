from pharmacy1os.workflow import (
    TRANSITIONS, allowed_transitions, can_transition, required_permission, role_can_transition,
)

def test_transition_parity():
    assert can_transition("RECEIVED", "DATA_ENTRY")
    assert not can_transition("DUR_REVIEW", "PRODUCT_FILL")
    assert can_transition("ON_HOLD", "DATA_ENTRY", "DATA_ENTRY")
    assert not can_transition("ON_HOLD", "READY", "DATA_ENTRY")
    assert not allowed_transitions("CANCELLED")

def test_pharmacist_gate():
    assert required_permission("PHARMACIST_REVIEW", "READY") == "verify"
    assert role_can_transition("PHARMACIST", "PHARMACIST_REVIEW", "READY")
    assert not role_can_transition("TECHNICIAN", "PHARMACIST_REVIEW", "READY")
    assert not role_can_transition("INTERN", "PHARMACIST_REVIEW", "READY")
    assert role_can_transition("CASHIER", "READY", "SOLD")

def test_no_invalid_edges():
    for state, targets in TRANSITIONS.items():
        for target in targets:
            assert can_transition(state, target)
    assert not role_can_transition("AUDITOR", "READY", "SOLD")
