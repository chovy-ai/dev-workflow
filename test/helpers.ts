// 集成测试脚手架：真实 fs + 真实 Store，穿过生产边界（run.json/group.json 落盘往返）。
// 不 mock Store / route / runtime——只做两件测试级布置：
//  1) 用临时 SHIP_HOME 隔离每个用例的磁盘状态；
//  2) 置 __shipBooted=true 跳过 getStore 的 bootRecover 自动续跑副作用（与归档逻辑无关）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store';
import { DEFAULT_CONFIG, type GroupRecord, type RunRecord } from '../lib/types';

type G = typeof globalThis & {
  __shipStore?: Store;
  __shipBooted?: boolean;
  __shipAdvancing?: Set<string>;
};

/** 新建隔离的临时 SHIP_HOME，并重置进程内的 store/lock 缓存 */
export function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-'));
  const g = globalThis as G;
  delete g.__shipStore;
  g.__shipBooted = true; // 跳过 bootRecover（自动续跑），避免测试触发真实流水线
  g.__shipAdvancing = new Set();
  process.env.SHIP_HOME = home;
  return home;
}

/** 从磁盘真实载入一个 Store 并设为进程内实例（getStore 会返回它） */
export function loadStore(home: string): Store {
  const g = globalThis as G;
  const store = new Store(home); // 构造即 loadAll/loadGroups，真实读盘
  g.__shipStore = store;
  g.__shipBooted = true;
  return store;
}

const ISO = '2026-01-01T00:00:00.000Z';

/** 往磁盘写一条完整合法的 run.json（走真实落盘布局） */
export function writeRun(home: string, over: Partial<RunRecord> & { id: string }): RunRecord {
  const run: RunRecord = {
    title: over.id,
    repoPath: home,
    branch: null,
    worktreePath: null,
    plan: 'plan',
    stage: 'done',
    status: 'done',
    statusDetail: '',
    reviewRound: 0,
    findings: [],
    advisories: [],
    prUrl: null,
    sdkSessions: {},
    createdAt: ISO,
    updatedAt: ISO,
    config: DEFAULT_CONFIG,
    ...over,
  };
  const dir = path.join(home, 'runs', run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

/** 往磁盘写一条 group.json */
export function writeGroup(
  home: string,
  over: Partial<GroupRecord> & { id: string; runIds: string[] },
): GroupRecord {
  const group: GroupRecord = {
    title: over.id,
    createdAt: ISO,
    ...over,
  };
  const dir = path.join(home, 'groups', group.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'group.json'), JSON.stringify(group, null, 2));
  return group;
}

/** 直接从磁盘读回 run.json（断言落盘保真用） */
export function readRun(home: string, id: string): RunRecord {
  return JSON.parse(fs.readFileSync(path.join(home, 'runs', id, 'run.json'), 'utf8'));
}

/** 直接从磁盘读回 group.json */
export function readGroup(home: string, id: string): GroupRecord {
  return JSON.parse(fs.readFileSync(path.join(home, 'groups', id, 'group.json'), 'utf8'));
}

/** 构造一个带 JSON body 的 POST Request */
export function postReq(body?: unknown): Request {
  return new Request('http://test.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 构造一个带 query 的 GET Request */
export function getReq(query = ''): Request {
  return new Request(`http://test.local/api${query}`);
}

/** route handler 的 ctx.params */
export function paramCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
