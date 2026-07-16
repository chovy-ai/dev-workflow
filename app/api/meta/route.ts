import { NextResponse } from 'next/server';
import { getMeta } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/** server 自述：pid / 启动时间 / 代码 HEAD。CLI 据此提示「server 跑的是旧代码，重启生效」。 */
export async function GET() {
  return NextResponse.json(await getMeta());
}
