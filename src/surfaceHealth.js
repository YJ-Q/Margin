import { CONTRACT_VERSION } from './contracts/contractTypes.js';

// One health payload for every surface.
//
// Four surfaces used to answer `/health` with four different shapes ({ok,status,contractVersion},
// {ok,status}, {status,name}, {status,service,pilotReady}). A consumer pointed at the wrong port got
// a structurally similar but semantically different answer, which is worse than an obvious failure:
// it looks like it worked. The shape is unified here and the surface names itself, so a caller can
// always tell what it reached.
//
// The payload deliberately carries only identity plus the contract version. Runtime state belongs in
// the surface's own endpoints, not in a health probe that a supervisor polls.
//
// `name` identifies the product (several unrelated local services run on loopback), `surface`
// identifies which of Margin's own boundaries answered.
export function healthPayload({ surface, extra = {} } = {}) {
  return Object.freeze({
    ok: true,
    status: 'ready',
    name: 'Margin',
    surface: surface ?? 'unknown',
    contractVersion: CONTRACT_VERSION,
    ...extra,
  });
}
