"""Gate-review relay stand-in. No GPIO, card UID, network or machine output.

The fixture supplies eligibility decisions, not evidence of live authorization.
Real API expiry/revocation/retraining paths are covered by backend integration tests.
"""
import json
import time
from access_client import RelayLease


class SimulatedRelay:
    def __init__(self):
        self.enabled = False
        self.events = []

    def __call__(self, enabled):
        self.enabled = bool(enabled)
        self.events.append({'seconds': round(time.monotonic(), 4), 'enabled': self.enabled})


def demonstrate():
    output = SimulatedRelay()
    relay = RelayLease(output)
    steps = []
    try:
        steps.append({'step': 'startup', 'enabled': output.enabled})
        relay.apply(.10)
        steps.append({'step': 'valid short grant', 'enabled': output.enabled})
        time.sleep(.15)
        steps.append({'step': 'deadline without renewal', 'enabled': output.enabled})
        relay.apply(5)
        relay.apply(0)
        steps.append({'step': 'revocation decision', 'enabled': output.enabled})
        relay.apply(0)
        steps.append({'step': 'still revoked before retraining', 'enabled': output.enabled})
        relay.close()
        replacement = RelayLease(output)
        try:
            steps.append({'step': 'restart does not restore old grant', 'enabled': output.enabled})
            replacement.apply(.1)
            steps.append({'step': 'fresh grant after verified retraining (fixture)', 'enabled': output.enabled})
        finally:
            replacement.close()
        steps.append({'step': 'shutdown', 'enabled': output.enabled})
        assert [s['enabled'] for s in steps] == [False, True, False, False, False, False, True, False]
        return {'simulationOnly': True, 'physicalMachineSwitchingTested': False, 'steps': steps}
    finally:
        relay.close()


if __name__ == '__main__':
    print(json.dumps(demonstrate(), indent=2))
