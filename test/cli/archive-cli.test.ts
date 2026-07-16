// CLI e2e：起真实 next dev server（临时 SHIP_HOME），CLI 经真实 HTTP 打到真实 Store。
// 不预告知 id 类型——archive <id> 的 run/group 识别全靠查真实 server。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRun, writeGroup } from '../helpers';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 4900 + Math.floor(Math.random() * 80);
const SERVER = `http://localhost:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-cli-e2e-'));
let server: ChildProcess;

/** 跑一条 CLI 命令，返回 { code, out } */
function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', 'cli/index.ts', ...args], {
    cwd: REPO,
    env: { ...process.env, SHIP_SERVER: SERVER },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

before(async () => {
  // 先落盘种子数据（server 启动时 Store.loadAll 才能载入）
  writeRun(home, { id: 'r-done', status: 'done', title: 'done-run' });
  writeRun(home, { id: 'r-fail', status: 'failed', title: 'fail-run' });
  writeRun(home, { id: 'gm1', status: 'done', groupId: 'g1' });
  writeRun(home, { id: 'gm2', status: 'done', groupId: 'g1' });
  writeGroup(home, { id: 'g1', runIds: ['gm1', 'gm2'], title: 'grp' });

  // detached：自成进程组，清理时按组 kill（next dev 会 fork 子进程，只 kill 父 PID 会留孤儿）
  server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: REPO,
    env: { ...process.env, SHIP_HOME: home },
    stdio: 'ignore',
    detached: true,
  });
  // 轮询就绪（首个请求会触发路由编译）
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER}/api/runs`);
      if (res.ok) break;
    } catch {
      /* server 未就绪 */
    }
    if (Date.now() > deadline) throw new Error('next dev 90s 内未就绪');
    await new Promise((r) => setTimeout(r, 1000));
  }
});

after(() => {
  // 按进程组 kill（detached 下 pid 即组 leader），确保 next fork 出的子进程一并回收
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('ls 默认不含已归档；archive <id> 自动识别 run/group；--done 命中 archive-done', () => {
  // 默认 ls 含 done/failed/成员，均未归档
  const ls0 = cli('ls');
  assert.equal(ls0.code, 0);
  assert.match(ls0.out, /r-done/);
  assert.match(ls0.out, /r-fail/);

  // archive r-done：自动识别为 run（未预告知类型）
  const a1 = cli('archive', 'r-done');
  assert.equal(a1.code, 0);
  assert.match(a1.out, /run r-done/);

  // 默认 ls 不再含 r-done；--archived 含
  assert.doesNotMatch(cli('ls').out, /r-done/);
  assert.match(cli('ls', '--archived').out, /r-done/);

  // archive g1：自动识别为组
  const a2 = cli('archive', 'g1');
  assert.equal(a2.code, 0);
  assert.match(a2.out, /组 g1/);
  // groups 默认不含 g1，--archived 含
  assert.doesNotMatch(cli('groups').out, /g1/);
  assert.match(cli('groups', '--archived').out, /g1/);

  // archive --done：走 archive-done（此时只剩 r-fail 是 failed → 不归档，计数 0）
  const a3 = cli('archive', '--done');
  assert.equal(a3.code, 0);
  assert.match(a3.out, /已归档 0 个散 run、0 个组/);

  // 不存在的 id → 退出码 1
  assert.equal(cli('archive', 'no-such-id').code, 1);
});

test('archive --done 归档 done 散 run 与全 done 组（计数精确）', () => {
  // 还原 r-done 与 g1（回到 done 活跃态），再一键归档
  cli('archive', 'r-done', '--restore');
  cli('archive', 'g1', '--restore');
  const r = cli('archive', '--done');
  assert.equal(r.code, 0);
  // 1 个散 done（r-done）+ 1 个全 done 组（g1）；r-fail 不计
  assert.match(r.out, /已归档 1 个散 run、1 个组/);
});
