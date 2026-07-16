import fs from 'node:fs';
import type { ShipTestPlan } from './types';

export type TestGatePhase = 'fast' | 'required' | 'all';

const EMPTY_TEST_PLAN: ShipTestPlan = { fast: [], required: [], e2e: [] };

function stringCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(commands: readonly string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

export function readEngineTestPlan(file: string): ShipTestPlan {
  if (!fs.existsSync(file)) return { ...EMPTY_TEST_PLAN };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`.ship/testplan.json 不是合法 JSON：${error}`);
  }
  const plan = parsed as Record<string, unknown>;
  return {
    fast: stringCommands(plan.fast),
    required: stringCommands(plan.required),
    e2e: stringCommands(plan.e2e),
  };
}

/** 仓库配置是最低门槛，engine 只能追加；legacy/自动探测仅在 required 为空时兜底。 */
export function mergeTestPlan(input: {
  configured?: Partial<ShipTestPlan>;
  engine?: Partial<ShipTestPlan>;
  legacyOrDetected?: string | null;
}): ShipTestPlan {
  const fast = unique([...(input.configured?.fast ?? []), ...(input.engine?.fast ?? [])]);
  const required = unique([
    ...(input.configured?.required ?? []),
    ...(input.engine?.required ?? []),
  ]);
  const e2e = unique([...(input.configured?.e2e ?? []), ...(input.engine?.e2e ?? [])]);
  if (required.length === 0 && input.legacyOrDetected?.trim()) {
    required.push(input.legacyOrDetected.trim());
  }
  return { fast, required, e2e };
}

export function commandsForPhase(plan: ShipTestPlan, phase: TestGatePhase): string[] {
  if (phase === 'fast') return plan.fast.length > 0 ? plan.fast : plan.required;
  if (phase === 'required') return plan.required.length > 0 ? plan.required : plan.fast;
  return unique([...plan.fast, ...plan.required, ...plan.e2e]);
}

