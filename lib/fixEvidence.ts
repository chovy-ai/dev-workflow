import fs from 'node:fs';
import type { ReviewFinding } from './types';

export interface FindingResolution {
  finding_id: string;
  status: 'fixed' | 'disputed';
  changed_files?: string[];
  evidence: string;
  test_file?: string;
  test_command?: string;
}

export interface FixResolutionManifest {
  resolutions: FindingResolution[];
}

export function readResolutionManifest(file: string): FixResolutionManifest {
  if (!fs.existsSync(file)) throw new Error(`修复未写证据清单：${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`修复证据清单不是合法 JSON：${error}`);
  }
  const resolutions = (parsed as { resolutions?: unknown }).resolutions;
  if (!Array.isArray(resolutions)) throw new Error('修复证据清单缺少 resolutions 数组');
  return { resolutions: resolutions as FindingResolution[] };
}

export function validateResolutionManifest(
  findings: ReviewFinding[],
  manifest: FixResolutionManifest,
): { errors: string[]; commands: string[] } {
  const errors: string[] = [];
  const commands: string[] = [];
  const byId = new Map(manifest.resolutions.map((item) => [item.finding_id?.trim(), item]));
  for (const finding of findings) {
    const id = finding.id?.trim();
    if (!id) {
      errors.push('存在没有 id 的 must-fix finding');
      continue;
    }
    const resolution = byId.get(id);
    if (!resolution) {
      errors.push(`${id} 没有对应 resolution`);
      continue;
    }
    if (resolution.status !== 'fixed' && resolution.status !== 'disputed') {
      errors.push(`${id} 的 status 必须是 fixed 或 disputed`);
    }
    if (!resolution.evidence?.trim()) errors.push(`${id} 缺少可查证 evidence`);
    if (finding.required_test_boundary?.trim() && !resolution.test_command?.trim()) {
      errors.push(`${id} 指定了 required_test_boundary，但没有 test_command`);
    }
    if (resolution.test_command?.trim()) commands.push(resolution.test_command.trim());
  }
  return { errors, commands: [...new Set(commands)] };
}

