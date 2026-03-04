#!/usr/bin/env npx tsx
/**
 * API Key Scope Test Runner
 *
 * Tests every permission scope by hitting a representative endpoint for each.
 * Creates temporary resources, verifies access, and cleans up afterwards.
 *
 * Usage:
 *   npx tsx scripts/test-api-keys.ts <API_KEY> [BASE_URL]
 *
 * Arguments:
 *   API_KEY   - A "Full Access" developer API key (vgk_...)
 *   BASE_URL  - Server URL (default: http://localhost:3000)
 *
 * The key MUST have all 19 scopes granted for a full pass.
 * If a scope is missing the test will report 403 (expected if intentional).
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.argv[2];
const BASE = (process.argv[3] ?? 'http://localhost:3000').replace(/\/$/, '');

if (!API_KEY) {
  console.error('Usage: npx tsx scripts/test-api-keys.ts <API_KEY> [BASE_URL]');
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const headers = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

interface TestResult {
  scope: string;
  endpoint: string;
  method: string;
  status: number;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else if (ct.includes('text/event-stream')) {
    // SSE — just read a bit then abort
    data = '(SSE stream opened)';
    // consume to avoid hanging
    try { await res.text(); } catch { /* ok */ }
  } else {
    data = await res.text().catch(() => '');
  }
  return { status: res.status, data };
}

function record(
  scope: string,
  endpoint: string,
  method: string,
  status: number,
  expectSuccess: boolean,
  detail = '',
) {
  const pass = expectSuccess ? status >= 200 && status < 300 : true;
  results.push({ scope, endpoint: `${method} ${endpoint}`, method, status, pass, detail });
}

function log(icon: string, msg: string) {
  console.log(`  ${icon}  ${msg}`);
}

// ─── Scope Tests ─────────────────────────────────────────────────────────────

// We'll store IDs of resources we create so we can reference & clean them up.
const created: {
  projectId?: string;
  rubricId?: string;
  modelId?: string;
  evaluationId?: string;
  runId?: string;
  datasetId?: string;
} = {};

async function testStatsRead() {
  const scope = 'stats:read';
  console.log(`\n── ${scope} ──`);
  const { status } = await request('GET', '/api/stats');
  record(scope, '/api/stats', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/stats → ${status}`);
}

// ─── Projects ────────────────────────────────────────────────────────────────

async function testProjectsRead() {
  const scope = 'projects:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/projects');
  record(scope, '/api/projects', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/projects → ${status}`);

  if (created.projectId) {
    const { status: s2 } = await request('GET', `/api/projects/${created.projectId}`);
    record(scope, `/api/projects/[id]`, 'GET', s2, true);
    log(s2 === 200 ? '✅' : '❌', `GET /api/projects/${created.projectId} → ${s2}`);
  }
}

async function testProjectsWrite() {
  const scope = 'projects:write';
  console.log(`\n── ${scope} ──`);

  // Create
  const { status, data } = await request('POST', '/api/projects', {
    name: `__test_project_${Date.now()}`,
    description: 'Created by API key test runner',
  });
  record(scope, '/api/projects', 'POST', status, true);
  log(status === 200 || status === 201 ? '✅' : '❌', `POST /api/projects → ${status}`);
  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.projectId = (data as Record<string, string>).id;
  }

  // Update
  if (created.projectId) {
    const { status: s2 } = await request('PATCH', `/api/projects/${created.projectId}`, {
      description: 'Updated by test runner',
    });
    record(scope, `/api/projects/[id]`, 'PATCH', s2, true);
    log(s2 === 200 ? '✅' : '❌', `PATCH /api/projects/${created.projectId} → ${s2}`);
  }
}

async function testProjectsExport() {
  const scope = 'projects:export';
  console.log(`\n── ${scope} ──`);

  if (!created.projectId) {
    log('⏭️', 'Skipped — no project created');
    record(scope, '/api/projects/[id]/export', 'GET', 0, false, 'skipped');
    return;
  }
  const { status } = await request('GET', `/api/projects/${created.projectId}/export`);
  record(scope, `/api/projects/[id]/export`, 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/projects/${created.projectId}/export → ${status}`);
}

// ─── Rubrics ─────────────────────────────────────────────────────────────────

async function testRubricsWrite() {
  const scope = 'rubrics:write';
  console.log(`\n── ${scope} ──`);

  const { status, data } = await request('POST', '/api/rubrics', {
    name: `__test_rubric_${Date.now()}`,
    description: 'Created by API key test runner',
    criteria: [
      { name: 'Accuracy', description: 'Is the response accurate?', maxScore: 10 },
      { name: 'Clarity', description: 'Is the response clear?', maxScore: 10 },
    ],
  });
  record(scope, '/api/rubrics', 'POST', status, true);
  log(status === 200 || status === 201 ? '✅' : '❌', `POST /api/rubrics → ${status}`);
  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.rubricId = (data as Record<string, string>).id;
  }

  if (created.rubricId) {
    // Version
    const { status: s2 } = await request('POST', `/api/rubrics/${created.rubricId}/versions`, {
      criteria: [
        { name: 'Accuracy v2', description: 'Updated accuracy criterion', maxScore: 10 },
      ],
    });
    record(scope, `/api/rubrics/[id]/versions`, 'POST', s2, true);
    log(s2 === 200 || s2 === 201 ? '✅' : '❌', `POST /api/rubrics/${created.rubricId}/versions → ${s2}`);
  }
}

async function testRubricsRead() {
  const scope = 'rubrics:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/rubrics');
  record(scope, '/api/rubrics', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/rubrics → ${status}`);

  if (created.rubricId) {
    const { status: s2 } = await request('GET', `/api/rubrics/${created.rubricId}`);
    record(scope, `/api/rubrics/[id]`, 'GET', s2, true);
    log(s2 === 200 ? '✅' : '❌', `GET /api/rubrics/${created.rubricId} → ${s2}`);
  }
}

// ─── Models ──────────────────────────────────────────────────────────────────

async function testModelsWrite() {
  const scope = 'models:write';
  console.log(`\n── ${scope} ──`);

  const { status, data } = await request('POST', '/api/models', {
    name: `__test_model_${Date.now()}`,
    provider: 'openai',
    modelId: 'gpt-4o-mini',
  });
  record(scope, '/api/models', 'POST', status, true);
  log(status === 200 || status === 201 ? '✅' : '❌', `POST /api/models → ${status}`);
  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.modelId = (data as Record<string, string>).id;
  }

  if (created.modelId) {
    const { status: s2 } = await request('PATCH', `/api/models/${created.modelId}`, {
      name: `__test_model_updated_${Date.now()}`,
    });
    record(scope, `/api/models/[id]`, 'PATCH', s2, true);
    log(s2 === 200 ? '✅' : '❌', `PATCH /api/models/${created.modelId} → ${s2}`);
  }
}

async function testModelsRead() {
  const scope = 'models:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/models');
  record(scope, '/api/models', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/models → ${status}`);

  if (created.modelId) {
    const { status: s2 } = await request('GET', `/api/models/${created.modelId}`);
    record(scope, `/api/models/[id]`, 'GET', s2, true);
    log(s2 === 200 ? '✅' : '❌', `GET /api/models/${created.modelId} → ${s2}`);
  }
}

async function testModelsVerify() {
  const scope = 'models:verify';
  console.log(`\n── ${scope} ──`);

  if (!created.modelId) {
    log('⏭️', 'Skipped — no model created');
    record(scope, '/api/models/[id]/verify', 'POST', 0, false, 'skipped');
    return;
  }
  // Verify will likely fail because we have no real API key, but we only
  // care about the auth layer returning 200/4xx vs 403.
  const { status } = await request('POST', `/api/models/${created.modelId}/verify`);
  // A 500 or similar means the scope check passed (model verify itself failed).
  const scopeOk = status !== 403;
  record(scope, `/api/models/[id]/verify`, 'POST', status, scopeOk, scopeOk ? '' : 'scope denied');
  log(scopeOk ? '✅' : '❌', `POST /api/models/${created.modelId}/verify → ${status} (scope ${scopeOk ? 'passed' : 'denied'})`);
}

// ─── Datasets ────────────────────────────────────────────────────────────────

async function testDatasetsWrite() {
  const scope = 'datasets:write';
  console.log(`\n── ${scope} ──`);

  const { status, data } = await request('POST', '/api/datasets', {
    name: `__test_dataset_${Date.now()}`,
    source: 'local',
    visibility: 'private',
    description: 'Created by API key test runner',
    samples: [
      { input: 'Test input 1' },
      { input: 'Test input 2', expected: 'Expected output 2' },
    ],
  });
  record(scope, '/api/datasets', 'POST', status, true);
  log(status === 200 || status === 201 ? '✅' : '❌', `POST /api/datasets → ${status}`);
  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.datasetId = (data as Record<string, string>).id;
  }

  if (created.datasetId) {
    // Add samples
    const { status: s2 } = await request('POST', `/api/datasets/${created.datasetId}/samples`, {
      samples: [{ input: 'Test input 3' }],
    });
    record(scope, `/api/datasets/[id]/samples`, 'POST', s2, true);
    log(s2 === 200 || s2 === 201 ? '✅' : '❌', `POST /api/datasets/${created.datasetId}/samples → ${s2}`);

    // Version
    const { status: s3 } = await request('POST', `/api/datasets/${created.datasetId}/versions`, {});
    record(scope, `/api/datasets/[id]/versions`, 'POST', s3, true);
    log(s3 === 200 || s3 === 201 ? '✅' : '❌', `POST /api/datasets/${created.datasetId}/versions → ${s3}`);

    // Update
    const { status: s4 } = await request('PATCH', `/api/datasets/${created.datasetId}`, {
      description: 'Updated by test runner',
    });
    record(scope, `/api/datasets/[id]`, 'PATCH', s4, true);
    log(s4 === 200 ? '✅' : '❌', `PATCH /api/datasets/${created.datasetId} → ${s4}`);
  }
}

async function testDatasetsRead() {
  const scope = 'datasets:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/datasets');
  record(scope, '/api/datasets', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/datasets → ${status}`);

  if (created.datasetId) {
    const { status: s2 } = await request('GET', `/api/datasets/${created.datasetId}`);
    record(scope, `/api/datasets/[id]`, 'GET', s2, true);
    log(s2 === 200 ? '✅' : '❌', `GET /api/datasets/${created.datasetId} → ${s2}`);
  }
}

async function testDatasetsExport() {
  const scope = 'datasets:export';
  console.log(`\n── ${scope} ──`);

  if (!created.datasetId) {
    log('⏭️', 'Skipped — no dataset created');
    record(scope, '/api/datasets/[id]/export', 'GET', 0, false, 'skipped');
    return;
  }
  const { status } = await request('GET', `/api/datasets/${created.datasetId}/export?format=jsonl`);
  const scopeOk = status !== 403;
  record(scope, `/api/datasets/[id]/export`, 'GET', status, scopeOk);
  log(scopeOk ? '✅' : '❌', `GET /api/datasets/${created.datasetId}/export → ${status}`);
}

// ─── Evaluations ─────────────────────────────────────────────────────────────

async function testEvaluationsWrite() {
  const scope = 'evaluations:write';
  console.log(`\n── ${scope} ──`);

  if (!created.projectId) {
    log('⏭️', 'Skipped — no project created');
    record(scope, '/api/evaluations', 'POST', 0, false, 'skipped');
    return;
  }

  const body: Record<string, unknown> = {
    projectId: created.projectId,
    mode: 'single',
    inputText: 'What is 2+2?',
  };
  if (created.rubricId) body.rubricId = created.rubricId;
  // Don't include modelConfigIds — the test model is not verified,
  // which would cause a 400 from the business-logic layer.

  const { status, data } = await request('POST', '/api/evaluations', body);
  // Treat any non-403 as scope-passed (400/500 = business logic, not auth).
  const scopeOk = status !== 403;
  record(scope, '/api/evaluations', 'POST', status, scopeOk);
  log(scopeOk ? '✅' : '❌', `POST /api/evaluations → ${status}`);
  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.evaluationId = (data as Record<string, string>).id;
  }

  if (created.evaluationId) {
    const patchBody: Record<string, unknown> = {};
    if (created.rubricId) patchBody.rubricId = created.rubricId;
    const { status: s2 } = await request('PATCH', `/api/evaluations/${created.evaluationId}`, patchBody);
    // PATCH may 400 if nothing to update — scope is what matters
    const patchScopeOk = s2 !== 403;
    record(scope, `/api/evaluations/[id]`, 'PATCH', s2, patchScopeOk);
    log(patchScopeOk ? '✅' : '❌', `PATCH /api/evaluations/${created.evaluationId} → ${s2}`);
  }
}

async function testEvaluationsRead() {
  const scope = 'evaluations:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/evaluations');
  record(scope, '/api/evaluations', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/evaluations → ${status}`);

  if (created.evaluationId) {
    const { status: s2 } = await request('GET', `/api/evaluations/${created.evaluationId}`);
    record(scope, `/api/evaluations/[id]`, 'GET', s2, true);
    log(s2 === 200 ? '✅' : '❌', `GET /api/evaluations/${created.evaluationId} → ${s2}`);

    // Runs list
    const { status: s3 } = await request('GET', `/api/evaluations/${created.evaluationId}/runs`);
    record(scope, `/api/evaluations/[id]/runs`, 'GET', s3, true);
    log(s3 === 200 ? '✅' : '❌', `GET /api/evaluations/${created.evaluationId}/runs → ${s3}`);
  }

  // Events (SSE)
  const { status: s4 } = await request('GET', '/api/events');
  const scopeOk = s4 !== 403;
  record(scope, '/api/events', 'GET', s4, scopeOk, 'SSE stream');
  log(scopeOk ? '✅' : '❌', `GET /api/events → ${s4} (SSE)`);
}

async function testEvaluationsRun() {
  const scope = 'evaluations:run';
  console.log(`\n── ${scope} ──`);

  if (!created.evaluationId) {
    log('⏭️', 'Skipped — no evaluation created');
    record(scope, '/api/evaluations/[id]/runs', 'POST', 0, false, 'skipped');
    return;
  }

  const { status, data } = await request('POST', `/api/evaluations/${created.evaluationId}/runs`, {});
  // The run may fail (no real model key) but 403 vs anything else tells us scope status.
  const scopeOk = status !== 403;
  record(scope, `/api/evaluations/[id]/runs`, 'POST', status, scopeOk);
  log(scopeOk ? '✅' : '❌', `POST /api/evaluations/${created.evaluationId}/runs → ${status}`);

  if (status < 300 && data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
    created.runId = (data as Record<string, string>).id;
  }
}

async function testEvaluationsJudge() {
  const scope = 'evaluations:judge';
  console.log(`\n── ${scope} ──`);

  if (!created.evaluationId || !created.runId) {
    log('⏭️', 'Skipped — no evaluation run created');
    record(scope, '/api/evaluations/[id]/runs/[runId]/human-judgment', 'POST', 0, false, 'skipped');
    return;
  }

  const { status } = await request(
    'POST',
    `/api/evaluations/${created.evaluationId}/runs/${created.runId}/human-judgment`,
    { overallScore: 7, reasoning: 'Test judgment from API key runner' },
  );
  const scopeOk = status !== 403;
  record(scope, `/api/evaluations/[id]/runs/[runId]/human-judgment`, 'POST', status, scopeOk);
  log(scopeOk ? '✅' : '❌', `POST human-judgment → ${status}`);
}

async function testEvaluationsExport() {
  const scope = 'evaluations:export';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/evaluations/export?format=jsonl');
  const scopeOk = status !== 403;
  record(scope, '/api/evaluations/export', 'GET', status, scopeOk);
  log(scopeOk ? '✅' : '❌', `GET /api/evaluations/export → ${status}`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

async function testConfigRead() {
  const scope = 'config:read';
  console.log(`\n── ${scope} ──`);

  const { status } = await request('GET', '/api/config/export?format=json');
  record(scope, '/api/config/export', 'GET', status, true);
  log(status === 200 ? '✅' : '❌', `GET /api/config/export → ${status}`);
}

async function testConfigWrite() {
  const scope = 'config:write';
  console.log(`\n── ${scope} ──`);

  // Use dry-run so we don't actually import anything
  const { status } = await request('POST', '/api/config/import?dryRun=true', {});
  // Even a 400 (bad body) means scope check passed; only 403 means denied.
  const scopeOk = status !== 403;
  record(scope, '/api/config/import', 'POST', status, scopeOk, 'dry-run');
  log(scopeOk ? '✅' : '❌', `POST /api/config/import (dry-run) → ${status}`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n── Cleanup ──');

  // Delete in reverse dependency order
  if (created.evaluationId) {
    const { status } = await request('DELETE', `/api/evaluations/${created.evaluationId}`);
    log(status < 300 ? '🧹' : '⚠️', `DELETE evaluation ${created.evaluationId} → ${status}`);
  }
  if (created.datasetId) {
    const { status } = await request('DELETE', `/api/datasets/${created.datasetId}`);
    log(status < 300 ? '🧹' : '⚠️', `DELETE dataset ${created.datasetId} → ${status}`);
  }
  if (created.rubricId) {
    const { status } = await request('DELETE', `/api/rubrics/${created.rubricId}`);
    log(status < 300 ? '🧹' : '⚠️', `DELETE rubric ${created.rubricId} → ${status}`);
  }
  if (created.modelId) {
    const { status } = await request('DELETE', `/api/models/${created.modelId}`);
    log(status < 300 ? '🧹' : '⚠️', `DELETE model ${created.modelId} → ${status}`);
  }
  if (created.projectId) {
    const { status } = await request('DELETE', `/api/projects/${created.projectId}`);
    log(status < 300 ? '🧹' : '⚠️', `DELETE project ${created.projectId} → ${status}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║     VIM-GYM  API Key Scope Test Runner            ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  Server : ${BASE}`);
  console.log(`  Key    : ${API_KEY.slice(0, 12)}...`);
  console.log(`  Time   : ${new Date().toISOString()}`);

  // Verify the server is reachable
  try {
    const res = await fetch(`${BASE}/api/stats`, { headers: headers() });
    if (res.status === 0) throw new Error('No response');
  } catch {
    console.error(`\n❌ Cannot reach ${BASE}. Is the dev server running?`);
    process.exit(1);
  }

  // ── Run all scope tests ──
  // Write tests run first so read tests have resources to fetch
  await testStatsRead();

  await testProjectsWrite();
  await testProjectsRead();
  await testProjectsExport();

  await testRubricsWrite();
  await testRubricsRead();

  await testModelsWrite();
  await testModelsRead();
  await testModelsVerify();

  await testDatasetsWrite();
  await testDatasetsRead();
  await testDatasetsExport();

  await testEvaluationsWrite();
  await testEvaluationsRead();
  await testEvaluationsRun();
  await testEvaluationsJudge();
  await testEvaluationsExport();

  await testConfigRead();
  await testConfigWrite();

  // ── Cleanup resources ──
  await cleanup();

  // ── Summary ──
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║     Results Summary                                ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const allScopes = [
    'stats:read',
    'projects:read', 'projects:write', 'projects:export',
    'rubrics:read', 'rubrics:write',
    'models:read', 'models:write', 'models:verify',
    'evaluations:read', 'evaluations:write', 'evaluations:run',
    'evaluations:export', 'evaluations:judge',
    'datasets:read', 'datasets:write', 'datasets:export',
    'config:read', 'config:write',
  ];

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const scope of allScopes) {
    const scopeResults = results.filter((r) => r.scope === scope);
    if (scopeResults.length === 0) {
      console.log(`  ⏭️  ${scope.padEnd(24)} — no tests`);
      skipped++;
      continue;
    }

    const allPass = scopeResults.every((r) => r.pass);
    const anySkipped = scopeResults.some((r) => r.detail === 'skipped');

    if (anySkipped) {
      console.log(`  ⏭️  ${scope.padEnd(24)} — skipped (missing prerequisite)`);
      skipped++;
    } else if (allPass) {
      const statuses = scopeResults.map((r) => `${r.method} ${r.status}`).join(', ');
      console.log(`  ✅  ${scope.padEnd(24)} — PASS  (${statuses})`);
      passed++;
    } else {
      const failures = scopeResults
        .filter((r) => !r.pass)
        .map((r) => `${r.endpoint} → ${r.status}`)
        .join('; ');
      console.log(`  ❌  ${scope.padEnd(24)} — FAIL  (${failures})`);
      failed++;
    }
  }

  console.log(`\n  Total: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${allScopes.length} scopes`);

  if (failed > 0) {
    console.log('\n  ⚠️  Some scopes failed. Check that your key has all scopes granted');
    console.log('     or review the detailed output above for error details.\n');
    process.exit(1);
  } else {
    console.log('\n  🎉 All tested scopes passed!\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err);
  process.exit(1);
});
