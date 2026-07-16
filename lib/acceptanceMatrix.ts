import fs from 'node:fs';

export interface AcceptanceMatrixItem {
  acceptance: string;
  production_entry: string;
  do_not_mock: string;
  test_level: 'unit' | 'integration' | 'e2e';
  test_command_hint: string;
}

export interface AcceptanceMatrix {
  items: AcceptanceMatrixItem[];
}

export function readAcceptanceMatrix(file: string): AcceptanceMatrix {
  if (!fs.existsSync(file)) throw new Error(`实现前验收矩阵未生成：${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`实现前验收矩阵不是合法 JSON：${error}`);
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) throw new Error('实现前验收矩阵 items 不能为空');
  const allowed = new Set(['unit', 'integration', 'e2e']);
  for (const [index, raw] of items.entries()) {
    const item = raw as Record<string, unknown>;
    for (const key of [
      'acceptance',
      'production_entry',
      'do_not_mock',
      'test_level',
      'test_command_hint',
    ]) {
      if (typeof item[key] !== 'string' || !item[key].trim()) {
        throw new Error(`实现前验收矩阵第 ${index + 1} 项缺少 ${key}`);
      }
    }
    if (!allowed.has(String(item.test_level))) {
      throw new Error(`实现前验收矩阵第 ${index + 1} 项 test_level 非法`);
    }
  }
  return { items: items as AcceptanceMatrixItem[] };
}

