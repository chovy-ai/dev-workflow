import type { ReviewFinding, RunConfig } from './types';

/** 给 reviewer 未显式编号的 finding 补稳定 id，后续 fix/recheck 都以此对账。 */
export function assignFindingIds(
  findings: ReviewFinding[],
  label: string,
): ReviewFinding[] {
  const prefix = label
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return findings.map((finding, index) => ({
    ...finding,
    id: finding.id?.trim() || `${prefix || 'FINDING'}-${String(index + 1).padStart(2, '0')}`,
  }));
}

/** reviewer namespace 防止双边审查都产出 F-1 时，resolution 对账发生碰撞。 */
export function namespaceFindingIds(
  findings: ReviewFinding[],
  namespace: string,
  fallbackLabel = namespace,
): ReviewFinding[] {
  const prefix = namespace
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'review';
  const seen = new Map<string, number>();
  return assignFindingIds(findings, fallbackLabel).map((finding) => {
    const raw = finding.id!.trim();
    const base = raw.startsWith(`${prefix}:`) ? raw : `${prefix}:${raw}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...finding, id: count === 1 ? base : `${base}-${count}` };
  });
}

/**
 * 终局救援只处理已经锁定范围内的旧意见与修复增量问题。
 * other 代表重新开荒，即使带 escape_reason 也必须熔断并进入后继 run。
 */
export function canRunScopedRescue(findings: ReviewFinding[]): boolean {
  return (
    findings.length > 0 &&
    findings.every((finding) => finding.origin === 'previous' || finding.origin === 'delta')
  );
}

/** 终局救援默认换一个 engine + 新会话，打破原实现上下文里的错误假设。 */
export function chooseRescueEngine(config: RunConfig): string {
  if (config.rescueEngine && config.engines[config.rescueEngine]) return config.rescueEngine;
  return (
    config.reviewEngines.find((name) => name !== config.engine && Boolean(config.engines[name])) ??
    config.engine
  );
}
