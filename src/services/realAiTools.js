'use strict';

// The primary system owns both authorization and audit logging for AI data
// tools.  This adapter deliberately forwards only the authenticated user JWT;
// it has no service-role credential and never accepts a browser-provided role.
function createRealAiTools({ url = require('../realConfig').url, key = require('../realConfig').key, request = fetch } = {}) {
  async function invoke(token, tool, body = {}) {
    if (typeof token !== 'string' || !token) {
      const error = new Error('missing authenticated session');
      error.code = 'REAL_ACCESS_DENIED';
      throw error;
    }
    let response;
    try {
      response = await request(`${url}/functions/v1/${tool}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (cause) {
      const error = new Error('AI tool unavailable');
      error.code = 'REAL_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error('AI tool rejected request');
      error.code = response.status === 401 || response.status === 403 ? 'REAL_ACCESS_DENIED' : 'REAL_UNAVAILABLE';
      throw error;
    }
    return data;
  }

  async function accessScope(token) {
    const result = await invoke(token, 'ai-access-scope');
    const scope = result?.scope;
    if (!scope || !['station', 'province', 'region4', 'all'].includes(scope.level) || scope.read_only !== true) {
      const error = new Error('invalid server verified access scope');
      error.code = 'REAL_ACCESS_DENIED';
      throw error;
    }
    return scope;
  }

  async function psychiatricSummary(token, { province = null, stationId = null } = {}) {
    const result = await invoke(token, 'ai-summary', { province, station_id: stationId });
    if (result?.report_type !== 'psychiatric_summary' || !Array.isArray(result.rows) || !result.scope) {
      const error = new Error('invalid AI summary response');
      error.code = 'REAL_DATA_UNVERIFIABLE';
      throw error;
    }
    return result;
  }

  return { accessScope, psychiatricSummary };
}

module.exports = { createRealAiTools };
