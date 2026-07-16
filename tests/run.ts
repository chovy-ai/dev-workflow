import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAcceptanceMatrix } from '../lib/acceptanceMatrix';
import { validateResolutionManifest } from '../lib/fixEvidence';
import {
  assignFindingIds,
  canRunScopedRescue,
  chooseRescueEngine,
  namespaceFindingIds,
} from '../lib/reviewPolicy';
import { recoveryForRun } from '../lib/recoveryPolicy';
import { commandsForPhase, mergeTestPlan } from '../lib/testPlan';
import { DEFAULT_CONFIG, type ReviewFinding, type RunRecord } from '../lib/types';

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✖ ${name}`);
    throw error;
  }
}

const finding = (origin: ReviewFinding['origin']): ReviewFinding => ({
  file: 'x.ts',
  issue: 'broken',
  must_fix: true,
  origin,
});

check('finding ids are stable', () => {
  const out = assignFindingIds(
    [
      { ...finding(undefined), id: 'F-EXPLICIT' },
      finding(undefined),
    ],
    'review-2-codex',
  );
  assert.equal(out[0].id, 'F-EXPLICIT');
  assert.equal(out[1].id, 'REVIEW-2-CODEX-02');
});

check('finding ids are namespaced and collision-safe across reviewers', () => {
  const out = namespaceFindingIds(
    [
      { ...finding(undefined), id: 'F-1' },
      { ...finding(undefined), id: 'F-1' },
    ],
    'codex',
  );
  assert.equal(out[0].id, 'codex:F-1');
  assert.equal(out[1].id, 'codex:F-1-2');
});

check('scoped rescue accepts previous+delta only', () => {
  assert.equal(canRunScopedRescue([finding('previous'), finding('delta')]), true);
  assert.equal(canRunScopedRescue([finding('previous'), finding('other')]), false);
  assert.equal(canRunScopedRescue([finding(undefined)]), false);
  assert.equal(canRunScopedRescue([]), false);
});

check('explicit recovery classification wins with legacy fallback', () => {
  const run = {
    stage: 'autoReview',
    findings: [finding('previous')],
  } as RunRecord;
  assert.equal(recoveryForRun(run), 'supersede');
  run.failureRecovery = 'resume';
  assert.equal(recoveryForRun(run), 'resume');
});

check('rescue uses a different configured engine by default', () => {
  assert.equal(chooseRescueEngine({ ...DEFAULT_CONFIG, engine: 'codex' }), 'claude');
  assert.equal(
    chooseRescueEngine({ ...DEFAULT_CONFIG, engine: 'codex', rescueEngine: 'codex' }),
    'codex',
  );
});

check('configured test gates cannot be replaced by engine test plan', () => {
  const plan = mergeTestPlan({
    configured: {
      fast: ['npm run unit'],
      required: ['npm run typecheck'],
      e2e: ['npm run e2e'],
    },
    engine: {
      fast: ['npm run focused', 'npm run unit'],
      required: [],
      e2e: [],
    },
    legacyOrDetected: 'npm test',
  });
  assert.deepEqual(plan.fast, ['npm run unit', 'npm run focused']);
  assert.deepEqual(plan.required, ['npm run typecheck']);
  assert.deepEqual(commandsForPhase(plan, 'all'), [
    'npm run unit',
    'npm run focused',
    'npm run typecheck',
    'npm run e2e',
  ]);
});

check('legacy test command is only a required fallback', () => {
  assert.deepEqual(
    mergeTestPlan({ engine: { fast: ['npm run unit'] }, legacyOrDetected: 'npm test' }).required,
    ['npm test'],
  );
});

check('finding evidence requires boundary-specific test command', () => {
  const contractFinding: ReviewFinding = {
    id: 'F-1',
    file: 'service.ts',
    issue: 'budget bypass',
    invariant: 'all additions share one budget',
    evidence: 'one direction ignores references',
    reproduction: 'add references then attachments',
    required_test_boundary: 'real service addition planner',
    must_fix: true,
  };
  assert.deepEqual(
    validateResolutionManifest([contractFinding], {
      resolutions: [{ finding_id: 'F-1', status: 'fixed', evidence: 'changed planner' }],
    }).errors,
    ['F-1 指定了 required_test_boundary，但没有 test_command'],
  );
  const valid = validateResolutionManifest([contractFinding], {
    resolutions: [
      {
        finding_id: 'F-1',
        status: 'fixed',
        evidence: 'shared planner counts both directions',
        test_command: 'npm run test -- budget',
      },
    ],
  });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.commands, ['npm run test -- budget']);
});

check('acceptance matrix requires complete production boundary fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-acceptance-'));
  const file = path.join(dir, 'matrix.json');
  fs.writeFileSync(file, JSON.stringify({ items: [{ acceptance: 'x' }] }));
  assert.throws(() => readAcceptanceMatrix(file), /缺少 production_entry/);
  fs.writeFileSync(
    file,
    JSON.stringify({
      items: [
        {
          acceptance: 'workspace entries are equivalent',
          production_entry: 'provider -> controller -> composer -> materializer',
          do_not_mock: 'providerItemToAgentMentionItem',
          test_level: 'integration',
          test_command_hint: 'npm run test -- entry-integration',
        },
      ],
    }),
  );
  assert.equal(readAcceptanceMatrix(file).items.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed`);
