// Minimal fetch wrapper for the Margin Recent Sessions / Smart Handoff surface.
// Talks to src/core/handoff/httpAdapter.js — a separate, independent boundary
// from the old Workstream/Run apiClient.js. No envelope/capability machinery
// here; the handoff adapter returns plain { ok, data } / { ok, error } JSON.
export function createMarginApiClient({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('invalid_margin_api_client_dependencies');

  async function request(path, options) {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, options);
      const body = await response.json();
      return body;
    } catch {
      return { ok: false, error: { code: 'transport_unavailable', message: 'Request failed' } };
    }
  }

  return Object.freeze({
    listSessions(limit) {
      const query = Number.isFinite(limit) ? `?limit=${encodeURIComponent(limit)}` : '';
      return request(`/api/sessions${query}`, { method: 'GET' });
    },
    getSessionsRevision() { return request('/api/sessions/revision', { method: 'GET' }); },
    getResourceStatus() { return request('/api/resources/status', { method: 'GET' }); },
    listAgentSources() { return request('/api/agent-sources', { method: 'GET' }); },
    detectAgentSources() { return request('/api/agent-sources/detect', { method: 'POST' }); },
    addAgentSource({ type, path, replaceId }) { return request('/api/agent-sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, path, replaceId }) }); },
    removeAgentSource(id) { return request(`/api/agent-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    enableAgentSource(id) { return request(`/api/agent-sources/${encodeURIComponent(id)}/enable`, { method: 'POST' }); },
    listWorkspaceSessions(workspaceKey) {
      return request(`/api/sessions?workspaceKey=${encodeURIComponent(workspaceKey)}`, { method: 'GET' });
    },
    getWorkspaceOverview(workspaceKey) {
      return request(`/api/workspace-overview?workspaceKey=${encodeURIComponent(workspaceKey)}`, { method: 'GET' });
    },
    generateHandoff({ sessionId, repo }) {
      return request('/api/handoff/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, repo })
      });
    },
    saveToWorkspace({ repo, markdown }) {
      return request('/api/handoff/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, markdown })
      });
    }
  });
}
