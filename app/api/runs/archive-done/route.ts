import { NextResponse } from 'next/server';
import { archiveDone } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * 一键归档：归档全部未归档的 done 散 run 与推导状态为 done 的组（连成员）。
 * failed 不纳入。返回实际变更数量 { runs, groups }（幂等，二次调用为 0）。
 */
export async function POST() {
  return NextResponse.json(archiveDone());
}
