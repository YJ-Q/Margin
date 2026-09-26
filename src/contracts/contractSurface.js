import { createHash } from 'node:crypto';
import {
  ACTOR_TYPES, COMMAND_TYPES, CONTRACT_VERSION, EVENT_QUERY_TYPES, EVENT_TYPES,
  MEMORY_LIFECYCLE_STATUSES, NEEDS_OWNER_STATUSES, NEEDS_OWNER_TYPES, QUERY_TYPES,
  RUN_STATUSES, SURFACE_KINDS, WORKER_KINDS, WORKSTREAM_STATUSES
} from './contractTypes.js';
import { WEB_COMMAND_CAPABILITIES, WEB_EVENT_CAPABILITIES, WEB_QUERY_CAPABILITIES } from '../http/webCapabilities.js';

// A single description of the declared contract surface: which types exist, what capability each one
// requires, and the closed enums a consumer switches on.
//
// It exists so the surface can be *checked* rather than restated. Everything here is derived from the
// declarations themselves, so it cannot drift from them; what it detects is a change to those
// declarations that was not announced by a CONTRACT_VERSION bump.
//
// DTO field shapes are deliberately out of scope — the DTO validation tests assert exact field sets, so a
// mapper change is caught there. Duplicating that here would mean two places to update for one change.
export function describeContractSurface() {
  return {
    version: CONTRACT_VERSION,
    commands: [...COMMAND_TYPES].sort(),
    queries: [...QUERY_TYPES].sort(),
    eventQueries: [...EVENT_QUERY_TYPES].sort(),
    events: [...EVENT_TYPES].sort(),
    actors: [...ACTOR_TYPES].sort(),
    surfaces: [...SURFACE_KINDS].sort(),
    workstreamStatuses: [...WORKSTREAM_STATUSES].sort(),
    runStatuses: [...RUN_STATUSES].sort(),
    needsOwnerTypes: [...NEEDS_OWNER_TYPES].sort(),
    needsOwnerStatuses: [...NEEDS_OWNER_STATUSES].sort(),
    workerKinds: [...WORKER_KINDS].sort(),
    memoryLifecycles: [...MEMORY_LIFECYCLE_STATUSES].sort(),
    commandCapabilities: Object.entries(WEB_COMMAND_CAPABILITIES).sort(),
    queryCapabilities: Object.entries(WEB_QUERY_CAPABILITIES).sort(),
    eventCapabilities: Object.entries(WEB_EVENT_CAPABILITIES).sort()
  };
}

export function contractSurfaceFingerprint() {
  return createHash('sha256').update(JSON.stringify(describeContractSurface())).digest('hex');
}
