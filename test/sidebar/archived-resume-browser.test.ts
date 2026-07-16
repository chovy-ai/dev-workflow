// 浏览器回归：真实 Next Page + 真实 HTTP 路由 + 无头 Chrome DOM。
// 不 mock fetch / Page / runtime；种子数据只在生产入口之前写入真实 SHIP_HOME。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../../lib/types';
import { writeRun } from '../helpers';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RUN_ID = 'browser-archived-run';
const ARCHIVED_AT = '2026-06-06T00:00:00.000Z';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-sidebar-browser-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-chrome-profile-'));

type CdpReply = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};

class CdpClient {
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private listeners = new Map<string, ((params: any) => void)[]>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as CdpReply;
      if (msg.id) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params);
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new CdpClient(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`无法连接 Chrome CDP：${url}`)), {
        once: true,
      });
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? '浏览器表达式执行失败');
    return result.result.value as T;
  }

  close() {
    this.socket.close();
  }
}

type SeenRequest = { url: string; method: string };
let server: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let cdp: CdpClient | undefined;
let serverPort = 0;
let serverLog = '';
const requests: SeenRequest[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      assert.ok(address && typeof address !== 'string');
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(description: string, probe: () => Promise<T | false>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${description}${lastError ? `；最后错误：${String(lastError)}` : ''}`);
}

function killGroup(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

before(async () => {
  assert.ok(fs.existsSync(CHROME), `浏览器回归需要 Chrome：${CHROME}`);

  // 独立 git 仓库让真实 resume 后的 Pipeline 停留在一个长运行 implement engine 中，
  // 既不 mock runtime，也不会碰当前仓库；测试结束时随 server 进程组一起清理 engine。
  const fixtureRepo = path.join(home, 'repo');
  fs.mkdirSync(fixtureRepo, { recursive: true });
  for (const args of [
    ['init', '-b', 'feature/browser'],
    ['config', 'user.email', 'browser-test@example.invalid'],
    ['config', 'user.name', 'Browser Test'],
  ]) {
    const result = spawnSync('git', args, { cwd: fixtureRepo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(fixtureRepo, 'seed.txt'), 'seed\n');
  assert.equal(spawnSync('git', ['add', '.'], { cwd: fixtureRepo }).status, 0);
  assert.equal(
    spawnSync('git', ['commit', '-m', 'seed'], { cwd: fixtureRepo, stdio: 'ignore' }).status,
    0,
  );

  writeRun(home, {
    id: RUN_ID,
    title: RUN_ID,
    repoPath: fixtureRepo,
    worktreePath: fixtureRepo,
    branch: 'feature/browser',
    stage: 'implement',
    status: 'failed',
    statusDetail: '等待人工续跑',
    archivedAt: ARCHIVED_AT,
    config: {
      ...DEFAULT_CONFIG,
      engine: 'browser-hold',
      engines: { ...DEFAULT_CONFIG.engines, 'browser-hold': ['sh', '-c', 'sleep 60'] },
    },
  });

  serverPort = await freePort();
  server = spawn('npx', ['next', 'dev', '-H', '127.0.0.1', '-p', String(serverPort)], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SHIP_HOME: home,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.on('data', (chunk) => (serverLog += chunk.toString()));
  server.stderr?.on('data', (chunk) => (serverLog += chunk.toString()));
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  await waitFor(
    'Next Page 就绪',
    async () => {
      const response = await fetch(serverUrl);
      return response.ok || false;
    },
    90_000,
  );

  // 用 --remote-debugging-port=0 让 Chrome 自选端口，消除“预选端口在 spawn 前被 Next dev 的
  // HMR/worker socket 抢占”导致 Chrome 调试服务起不来、CDP 端点永远 fetch failed 的竞态。
  // Chrome 只有在调试服务真正监听后，才把「端口\nws路径」写入 user-data-dir/DevToolsActivePort。
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const chromePort = await waitFor(
    'Chrome DevTools 端口写入',
    async () => {
      if (!fs.existsSync(activePortFile)) return false;
      const firstLine = fs.readFileSync(activePortFile, 'utf8').split('\n')[0]?.trim();
      const port = Number(firstLine);
      return Number.isInteger(port) && port > 0 ? port : false;
    },
    30_000,
  );
  const target = await waitFor(
    'Chrome CDP 就绪',
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`,
        { method: 'PUT' },
      );
      if (!response.ok) return false;
      const json = (await response.json()) as { webSocketDebuggerUrl?: string };
      return json.webSocketDebuggerUrl || false;
    },
    30_000,
  );
  cdp = await CdpClient.connect(target);
  await Promise.all([cdp.call('Page.enable'), cdp.call('Runtime.enable'), cdp.call('Network.enable')]);
  cdp.on('Network.requestWillBeSent', ({ request }: { request: SeenRequest }) => {
    requests.push({ url: request.url, method: request.method });
  });
  await cdp.call('Page.navigate', { url: serverUrl });
  await waitFor('Page hydration 与活跃列表加载', async () => {
    const ready = await cdp!.evaluate<boolean>(
      `document.querySelector('.side-section.archived .side-section-head.clickable') !== null`,
    );
    const activeLoaded = requests.some(
      (request) => request.method === 'GET' && request.url === `${serverUrl}/api/runs`,
    );
    return (ready && activeLoaded) || false;
  });
});

after(() => {
  cdp?.close();
  killGroup(chrome);
  killGroup(server);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('真实 Page：归档懒加载后从详情 resume，条目只留在「进行中」', async () => {
  assert.ok(cdp);
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const archivedRequests = () =>
    requests.filter(
      (request) =>
        request.method === 'GET' &&
        request.url.startsWith(`${serverUrl}/api/`) &&
        new URL(request.url).searchParams.get('archived') === '1',
    );

  // 初始折叠态必须严格零 archived=1 请求，避免把“懒加载”退化成预取。
  assert.equal(archivedRequests().length, 0);

  const opened = await cdp.evaluate<boolean>(`(() => {
    const header = document.querySelector('.side-section.archived .side-section-head.clickable');
    if (!(header instanceof HTMLElement)) return false;
    header.click();
    return true;
  })()`);
  assert.equal(opened, true);
  await waitFor('展开归档区并完成两条 archived=1 懒加载', async () => {
    const visible = await cdp!.evaluate<boolean>(
      `document.querySelector('.side-section.archived')?.textContent?.includes(${JSON.stringify(RUN_ID)}) === true`,
    );
    return (archivedRequests().length === 2 && visible) || false;
  });

  // 从已归档侧边栏条目进入真实详情，等待真实 failed banner 的 resume 按钮。
  const detailOpened = await cdp.evaluate<boolean>(`(() => {
    const item = [...document.querySelectorAll('.side-section.archived .side-item.run')]
      .find((node) => node.textContent?.includes(${JSON.stringify(RUN_ID)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  assert.equal(detailOpened, true);
  await waitFor('已归档 failed run 详情与 resume 按钮', async () =>
    cdp!.evaluate<boolean>(
      `[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('从断点续跑'))`,
    ),
  );

  const resumed = await cdp.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('从断点续跑'));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(resumed, true);

  await waitFor('resume POST、活跃/归档刷新及侧边栏 DOM 互斥', async () => {
    const resumePosted = requests.some(
      (request) =>
        request.method === 'POST' && request.url === `${serverUrl}/api/runs/${RUN_ID}/resume`,
    );
    const domExclusive = await cdp!.evaluate<boolean>(`(() => {
      const title = ${JSON.stringify(RUN_ID)};
      const archivedMatches = [...document.querySelectorAll('.side-section.archived .side-item')]
        .filter((node) => node.textContent?.includes(title));
      const activeMatches = [...document.querySelectorAll('.side-section:not(.archived) .side-item')]
        .filter((node) => node.textContent?.includes(title));
      const runningSection = [...document.querySelectorAll('.side-section:not(.archived)')]
        .find((section) => section.querySelector('.side-section-head > span')?.textContent?.trim() === '进行中');
      return archivedMatches.length === 0 && activeMatches.length === 1 &&
        runningSection?.contains(activeMatches[0]) === true;
    })()`);
    // 展开时 runs/groups 各一次，resume 后刷新缓存再各一次。
    return (resumePosted && archivedRequests().length >= 4 && domExclusive) || false;
  }, 30_000).catch((error) => {
    throw new Error(`${String(error)}\nNext server log:\n${serverLog.slice(-8000)}`);
  });

  assert.equal(
    requests.filter(
      (request) =>
        request.method === 'POST' && request.url === `${serverUrl}/api/runs/${RUN_ID}/resume`,
    ).length,
    1,
    '详情中的真实 resume 按钮应只发出一次 POST',
  );
});
