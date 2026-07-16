#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  type GroupRecord,
  type GroupStatus,
  type RunEvent,
  type RunRecord,
} from '../lib/types';
import { recoveryForRun } from '../lib/recoveryPolicy';

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
  running: '▶', failed: '✖', done: '✔',
};

/** 裸 GET（不因 4xx 退出，用于探测资源是否存在）；网络不通才退出提示启动 server */
async function rawGet(p: string): Promise<Response> {
  try {
    return await fetch(`${SERVER}${p}`);
  } catch {
    console.error(`✖ 连不上 server（${SERVER}）。先启动：ship serve`);
    process.exit(3);
  }
}

/** 查真实 server 判定 id 是 run 还是组（先查 run 再查 group）；都 404 返回 null */
async function detectKind(id: string): Promise<'run' | 'group' | null> {
  if ((await rawGet(`/api/runs/${id}`)).ok) return 'run';
  if ((await rawGet(`/api/groups/${id}`)).ok) return 'group';
  return null;
}

function printRun(r: RunRecord) {
  console.log(
    `${STATUS_ICON[r.status] ?? '?'} ${r.id}  [${r.stage}/${r.status}]  ${r.title}` +
      (r.statusDetail ? `\n    ${r.statusDetail}` : '') +
      (r.prUrl ? `\n    PR: ${r.prUrl}` : ''),
  );
}

const webUrl = (id: string) => `${SERVER}/#/run/${id}`;
const groupWebUrl = (id: string) => `${SERVER}/#/group/${id}`;

/** 展开 ~ / ~/ 前缀为家目录 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 取路径最后一段目录名（用于概览显示） */
const dirName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/** 组列表项：GroupRecord + 推导状态 + 成员摘要 */
type GroupSummary = GroupRecord & {
  status: GroupStatus;
  runs: { id: string; repoPath: string; stage: string; status: string }[];
};

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

function reportResult(run: RunRecord) {
  console.log('');
  printRun(run);
  if (run.status === 'failed') {
    const recovery = recoveryForRun(run);
    console.log(
      recovery === 'supersede'
        ? `\n→ 审查熔断。保留成果创建后继执行：ship supersede ${run.id}   （详情：${webUrl(run.id)}）`
        : `\n→ 环境/执行中断。可从断点续跑：ship resume ${run.id}   （详情：${webUrl(run.id)}）`,
    );
  }
  else if (run.status === 'done') console.log('\n→ 已全自动完成，PR 已合并');
}

const prog = new Command('ship').description('方案 → 自动合并 PR 的代码化交付 harness（全自动，Next.js server + web 只读看板，本地）');

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
  .description('从已确认的方案启动一条流水线（--plan，在目标仓库目录里运行）或一个运行组（--group）')
  .option('--plan <file>', '方案 markdown 文件（单仓）')
  .option('--group <manifest>', '运行组清单 JSON（多仓库联动）')
  .option('--engine <name>', '实现/修复步骤用的 engine（如 claude / codex，默认 claude；双边审查不受影响。--group 时作为各仓库的默认值，可被清单里的 engine 覆盖）')
  .option('--no-attach', '只创建不跟踪（单仓）')
  .action(async (o) => {
    if (o.group) return startGroup(o.group, o.engine);
    if (!o.plan) {
      console.error('✖ 需要 --plan <file> 或 --group <manifest.json>');
      process.exit(1);
    }
    const planFile = path.resolve(o.plan);
    if (!fs.existsSync(planFile)) {
      console.error(`✖ 方案文件不存在：${planFile}`);
      process.exit(1);
    }
    const run = (await api('POST', '/api/runs', {
      repoPath: process.cwd(),
      plan: fs.readFileSync(planFile, 'utf8'),
      ...(o.engine ? { config: { engine: o.engine } } : {}),
    })) as RunRecord;
    console.log(`已创建运行 ${run.id}\nweb: ${webUrl(run.id)}\n`);
    if (o.attach) reportResult(await attach(run.id));
  });

/**
 * 组清单格式：{ title, engine?, repos: [{ path, plan, engine? }] }
 * path 支持 ~ 展开和相对路径（相对清单文件所在目录）；plan 是该仓库内的方案文件路径。
 * engine 决定该仓库实现/修复步骤用哪个 engine，优先级：仓库项 > 清单顶层 > --engine > 默认。
 * CLI 读出各方案文本后 POST /api/groups（server 不解析相对路径）。
 */
async function startGroup(manifestArg: string, engineFlag?: string) {
  const manifestFile = path.resolve(manifestArg);
  if (!fs.existsSync(manifestFile)) {
    console.error(`✖ 组清单不存在：${manifestFile}`);
    process.exit(1);
  }
  let manifest: {
    title?: string;
    engine?: string;
    repos?: {
      path?: string;
      plan?: string;
      engine?: string;
      /** 依赖声明（可选）：name 唯一标识；dependsOn 指向其它成员的 name */
      name?: string;
      dependsOn?: string[];
      /** 该成员合并后会发布的包（下游据此等待发布并 depBump） */
      publishes?: { package: string; check?: string; timeoutMinutes?: number };
    }[];
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (e) {
    console.error(`✖ 组清单不是合法 JSON：${(e as Error).message}`);
    process.exit(1);
  }
  if (!manifest.title || !Array.isArray(manifest.repos) || manifest.repos.length === 0) {
    console.error('✖ 清单需要 title 和非空 repos');
    process.exit(1);
  }
  const manifestDir = path.dirname(manifestFile);
  const repos = manifest.repos.map((r, i) => {
    if (!r.path || !r.plan) {
      console.error(`✖ 第 ${i + 1} 个 repo 需要 path 和 plan`);
      process.exit(1);
    }
    const repoPath = path.resolve(manifestDir, expandHome(r.path));
    const planFile = path.resolve(repoPath, expandHome(r.plan));
    if (!fs.existsSync(planFile)) {
      console.error(`✖ 方案文件不存在：${planFile}（仓库 ${r.path}）`);
      process.exit(1);
    }
    const engine = r.engine ?? manifest.engine ?? engineFlag;
    return {
      repoPath,
      plan: fs.readFileSync(planFile, 'utf8'),
      ...(engine ? { config: { engine } } : {}),
      // 依赖声明原样透传，server 侧统一校验（未知 name/自依赖/成环 → 整组 400）
      ...(r.name ? { name: r.name } : {}),
      ...(r.dependsOn?.length ? { dependsOn: r.dependsOn } : {}),
      ...(r.publishes ? { publishes: r.publishes } : {}),
    };
  });

  const { group, runs } = (await api('POST', '/api/groups', { title: manifest.title, repos })) as {
    group: GroupRecord;
    runs: RunRecord[];
  };
  console.log(
    `已创建运行组 ${group.id}（${group.runIds.length} 个仓库）\nweb: ${groupWebUrl(group.id)}\n`,
  );
  for (const r of runs) console.log(`  ${r.id}  ${dirName(r.repoPath)}`);
  console.log('\n→ 各仓库独立全自动推进，打开 web 看进度；或 ship groups 查看');
}

prog
  .command('ls')
  .description('列出运行（默认不含已归档）')
  .option('--archived', '只列出已归档的运行')
  .action(async (o) => {
    const runs = (await api('GET', `/api/runs${o.archived ? '?archived=1' : ''}`)) as RunRecord[];
    if (!runs.length) return console.log(o.archived ? '（没有已归档运行）' : '（还没有运行）');
    for (const r of runs) printRun(r);
  });

prog
  .command('archive [id]')
  .description('归档 run 或组（自动识别 id）；--done 一键归档全部已完成')
  .option('--done', '归档全部已完成的散 run 与全 done 的组（等价 archive-done）')
  .option('--restore', '还原（取消归档）而非归档')
  .action(async (id, o) => {
    if (o.done) {
      const { runs, groups } = (await api('POST', '/api/runs/archive-done')) as {
        runs: number;
        groups: number;
      };
      return console.log(`✔ 已归档 ${runs} 个散 run、${groups} 个组`);
    }
    if (!id) {
      console.error('✖ 需要 <id>（run 或组）或 --done');
      process.exit(1);
    }
    const archived = !o.restore;
    const verb = archived ? '已归档' : '已还原';
    // 自动识别 id 属于 run 还是组：查真实 server（先 run 后 group）
    const kind = await detectKind(id);
    if (kind === 'run') {
      await api('POST', `/api/runs/${id}/archive`, { archived });
      console.log(`✔ ${verb} run ${id}`);
    } else if (kind === 'group') {
      await api('POST', `/api/groups/${id}/archive`, { archived });
      console.log(`✔ ${verb} 组 ${id}`);
    } else {
      console.error(`✖ 未找到 run 或组：${id}`);
      process.exit(1);
    }
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
    if (run.status !== 'running') return reportResult(run);
    reportResult(await attach(id));
  });

prog
  .command('resume <id>')
  .description('续跑一个被中断/失败的运行（从持久化的阶段继续，worktree 没了会从分支重建）')
  .option('--no-attach', '只触发不跟踪')
  .action(async (id, o) => {
    const run = (await api('POST', `/api/runs/${id}/resume`)) as RunRecord;
    console.log(`⟲ 已续跑 ${run.id}（从阶段 ${run.stage} 继续）\nweb: ${webUrl(run.id)}\n`);
    if (o.attach) reportResult(await attach(run.id));
  });

prog
  .command('supersede <id>')
  .description('从 failed run 的保留分支创建后继执行（继承实现与 findings，重置审查预算）')
  .option('--plan <file>', '修订后的方案文件；缺省沿用父 run 方案')
  .option('--engine <name>', '后继实现/修复 engine')
  .option('--no-attach', '只创建不跟踪')
  .action(async (id, o) => {
    let plan: string | undefined;
    if (o.plan) {
      const planFile = path.resolve(o.plan);
      if (!fs.existsSync(planFile)) {
        console.error(`✖ 方案文件不存在：${planFile}`);
        process.exit(1);
      }
      plan = fs.readFileSync(planFile, 'utf8');
    }
    const run = (await api('POST', `/api/runs/${id}/supersede`, {
      ...(plan ? { plan } : {}),
      ...(o.engine ? { config: { engine: o.engine } } : {}),
    })) as RunRecord;
    console.log(
      `↪ 已创建后继运行 ${run.id}（父 run ${id}，来源分支 ${run.sourceBranch}）\n` +
        `web: ${webUrl(run.id)}\n`,
    );
    if (o.attach) reportResult(await attach(run.id));
  });

// ---------- 运行组（run group） ----------

prog
  .command('groups')
  .description('列出运行组（状态 + 成员概览，默认不含已归档）')
  .option('--archived', '只列出已归档的运行组')
  .action(async (o) => {
    const groups = (await api(
      'GET',
      `/api/groups${o.archived ? '?archived=1' : ''}`,
    )) as GroupSummary[];
    if (!groups.length)
      return console.log(o.archived ? '（没有已归档运行组）' : '（还没有运行组）');
    for (const g of groups) {
      console.log(`${STATUS_ICON[g.status] ?? '?'} ${g.id}  [${g.status}]  ${g.title}`);
      for (const r of g.runs)
        console.log(
          `    ${STATUS_ICON[r.status] ?? '?'} ${dirName(r.repoPath)}  [${r.stage}/${r.status}]  ${r.id}`,
        );
    }
  });

prog.parseAsync();
