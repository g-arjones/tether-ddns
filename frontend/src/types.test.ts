import { expectTypeOf, test } from 'vitest';
import type { StateSnapshot, Reachability, ResolverProbe, CheckRecord } from './types';

test('snapshot carries reachability telemetry', () => {
  expectTypeOf<StateSnapshot>().toHaveProperty('reachability');
  expectTypeOf<StateSnapshot>().toHaveProperty('next_check_at');
  expectTypeOf<StateSnapshot>().toHaveProperty('ipv4_changed_at');
  expectTypeOf<Reachability>().toHaveProperty('history');
  expectTypeOf<ResolverProbe>().toHaveProperty('latency_ms');
  expectTypeOf<CheckRecord>().toHaveProperty('successes');
});
