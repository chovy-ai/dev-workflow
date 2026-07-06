#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, type RunEvent, type RunRecord } from '../lib/types';

const SERVER = process.env.SHIP_SERVER ?? `http://localhost:${DEFAULT_PORT}`;
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function api(method: string, p: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error(`✖ 连不上 server（${SERVER}）。先启动：ship serve`);
    process.exit(3);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✖ ${data.error ?? res.statusText}`);
    process.exit(1);
  }
  return data;
}

const STATUS_ICON: Record<string, string> = {
  running: '▶', awaiting_review: '⏸', blocked: '⛔', failed: '✖', done: '✔',
};

function printRun(r: RunRecord) {
  console.log(
    `${STATUS_ICON[r.status] ?? '?'} ${r.id}  [${r.stage}/${r.status}]  ${r.title}` +
      (r.statusDetail ? `\n    ${r.statusDetail}` : '') +
      (r.prUrl ? `\n    PR: ${r.prUrl}` : ''),
  );
}

const webUrl = (id: string) => `${SERVER}/#/run/${id}`;

/** 通过 SSE 实时跟踪一个 run，直到进入暂停/终态 */
async function attach(runId: string): Promise<RunRecord> {
  const res = await fetch(`${SERVER}/api/runs/${runId}/events?after=0`);
  if (!res.ok || !res.body) throw new Error(`事件流打开失败：${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let synced = false; // sync 标记之前的 status 事件是历史回放，不代表当前状态
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
      if (!data) continue;
      const ev = JSON.parse(data) as RunEvent;
      const d = ev.data as any;
      if (ev.type === 'log') console.log(`  ${d.msg}`);
      else if (ev.type === 'stage') console.log(`\n== 阶段 ${d.stage} ==`);
      else if (ev.type === 'engine-line') console.log(`    │ ${d.line}`);
      else if (ev.type === 'sync') {
        synced = true;
        const run = (await api('GET', `/api/runs/${runId}`)) as RunRecord;
        if (run.status !== 'running') {
          reader.cancel().catch(() => {});
          return run;
        }
      } else if (ev.type === 'status' && synced && d.status !== 'running') {
        reader.cancel().catch(() => {});
        return (await api('GET', `/api/runs/${runId}`)) as RunRecord;
      }
    }
  }
  return (await api('GET', `/api/runs/${runId}`)) as RunRecord;
}

function reportPause(run: RunRecord) {
  console.log('');
  printRun(run);
  if (run.status === 'awaiting_review')
    console.log(`\n→ 打开 web review：${webUrl(run.id)}\n  （或 ship approve ${run.id} / ship reject ${run.id} -m "意见"）`);
  else if (run.status === 'blocked' || run.status === 'failed')
    console.log(`\n→ 处理后续跑：ship continue ${run.id}   （详情：${webUrl(run.id)}）`);
  else if (run.status === 'done') console.log('\n→ 请人工审阅并合并 PR（harness 永不 merge）');
}

const prog = new Command('ship').description('方案 → PR 的代码化交付 harness（Next.js server + web review，本地）');

prog
  .command('serve')
  .description('启动 server + web（next dev）')
  .option('--port <port>', '端口', String(DEFAULT_PORT))
  .option('--prod', '用 next build + start 跑生产模式')
  .action((o) => {
    const args = o.prod ? ['next', 'start', '-p', o.port] : ['next', 'dev', '-p', o.port];
    spawn('npx', args, { cwd: PKG_ROOT, stdio: 'inherit' });
  });

prog
  .command('start')
  .description('从已确认的方案启动一条流水线（在目标仓库目录里运行）')
  .requiredOption('--plan <file>', '方案 markdown 文件')
  .option('--no-attach', '只创建不跟踪')
  .action(async (o) => {
    const planFile = path.resolve(o.plan);
    if (!fs.existsSync(planFile)) {
      console.error(`✖ 方案文件不存在：${planFile}`);
      process.exit(1);
    }
    const run = (await api('POST', '/api/runs', {
      repoPath: process.cwd(),
      plan: fs.readFileSync(planFile, 'utf8'),
    })) as RunRecord;
    console.log(`已创建运行 ${run.id}\nweb: ${webUrl(run.id)}\n`);
    if (o.attach) reportPause(await attach(run.id));
  });

prog.command('ls').description('列出所有运行').action(async () => {
  const runs = (await api('GET', '/api/runs')) as RunRecord[];
  if (!runs.length) console.log('（还没有运行）');
  for (const r of runs) printRun(r);
});

prog
  .command('status <id>')
  .description('查看某个运行')
  .action(async (id) => printRun((await api('GET', `/api/runs/${id}`)) as RunRecord));

prog
  .command('attach <id>')
  .description('实时跟踪运行输出')
  .action(async (id) => {
    const run = (await api('GET', `/api/runs/${id}`)) as RunRecord;
    if (run.status !== 'running') return reportPause(run);
    reportPause(await attach(id));
  });

prog
  .command('approve <id>')
  .description('人工 review 通过 → 提 PR → CI')
  .action(async (id) => {
    await api('POST', `/api/runs/${id}/approve`);
    console.log('已通过，继续跟踪：');
    reportPause(await attach(id));
  });

prog
  .command('reject <id>')
  .description('人工打回：修复 → LLM 复审 → 重新到人工门禁')
  .requiredOption('-m, --message <feedback>', '打回意见')
  .action(async (id, o) => {
    await api('POST', `/api/runs/${id}/reject`, { feedback: o.message });
    console.log('已打回，继续跟踪：');
    reportPause(await attach(id));
  });

prog
  .command('cancel <id>')
  .description('取消一个停着的运行（释放该仓库的流水线名额）')
  .action(async (id) => {
    await api('POST', `/api/runs/${id}/cancel`);
    console.log(`已取消 ${id}`);
  });

prog
  .command('continue <id>')
  .description('阻塞处理后从当前阶段续跑')
  .action(async (id) => {
    await api('POST', `/api/runs/${id}/continue`);
    reportPause(await attach(id));
  });

prog.parseAsync();
