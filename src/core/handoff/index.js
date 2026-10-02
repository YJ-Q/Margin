export { discoverSessions, resolveCodexHome, captureSession, readSessionSource, readSessionMetaSource } from './session-source.js';
export { buildEvidence } from './evidence.js';
export { refreshRepoTruth, observeFile, sha256 } from './repo-truth.js';
export { distill } from './distiller.js';
export { selectSmart } from './smartSelect.js';
export { renderSmartHandoff } from './handoff.js';
export { projectResumeSummary } from './resume-summary.js';
export {
  extractRecoveryObject,
  validateRecoveryObject,
  parseRecovery,
  buildStructuredRecoveryRequest,
  buildRecoveryTurnMessage,
  RECOVERY_REQUIRED_FIELDS,
  RECOVERY_ALL_FIELDS,
  RECOVERY_JSON_SCHEMA
} from './recoveryJson.js';
export { createWorkspaceOverview, selectLatestSession } from './workspace-overview.js';
export { createHandoffArtifact, snapshotPathForCanonicalSession } from './handoffArtifact.js';
export { saveHandoffArtifact } from './save.js';

import { readSessionSource } from './session-source.js';
import { buildEvidence } from './evidence.js';
import { refreshRepoTruth } from './repo-truth.js';
import { distill } from './distiller.js';
import { selectSmart } from './smartSelect.js';
import { renderSmartHandoff } from './handoff.js';
import { projectResumeSummary } from './resume-summary.js';

// Full pipeline: capture → evidence → repoTruth → distilled → Smart selection → markdown.
// capture: from captureSession(); workspace: absolute path to repo; artifactPaths: optional JSON reports.
// `state` returned here is the full Distilled State (unabridged); Smart selection
// only shapes what renderSmartHandoff sees, so future Detailed/Deep views can
// still read the same unabridged `state`.
export function generateHandoff(capture, workspace, { artifactPaths = [] } = {}) {
  const source = readSessionSource(capture);
  const evidence = buildEvidence(source);
  const truth = refreshRepoTruth(workspace, evidence, artifactPaths);
  const state = distill(evidence, truth);
  const markdown = renderSmartHandoff(selectSmart(state), truth);
  const resumeSummary = projectResumeSummary(state, truth);
  return { evidence, truth, state, markdown, resumeSummary };
}
