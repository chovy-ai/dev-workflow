import type { FailureRecovery, RunRecord } from './types';

/**
 * 新 run 直接读取显式分类；旧 run 兼容历史数据，只在 autoReview 且已有终局 findings 时推断 supersede。
 */
export function recoveryForRun(run: RunRecord): FailureRecovery {
  return (
    run.failureRecovery ??
    (run.stage === 'autoReview' && run.findings.length > 0 ? 'supersede' : 'resume')
  );
}
