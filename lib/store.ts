import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { RunEvent, RunEventType, RunRecord } from './types';

/**
 * 持久化布局（SHIP_HOME，默认 ~/.ship-server）：
 *   runs/<id>/run.json        运行记录（状态机快照）
 *   runs/<id>/events.ndjson   事件流（web/cli 回放 + 实时推送的数据源）
 *   runs/<id>/engine-logs/    每次 engine 调用的完整输出
 */
export class Store {
  readonly root: string;
  private runs = new Map<string, RunRecord>();
  private seqs = new Map<string, number>();
  /** 实时事件总线：emit(runId, event) */
  readonly bus = new EventEmitter();

  constructor(root?: string) {
    this.root = root ?? process.env.SHIP_HOME ?? path.join(os.homedir(), '.ship-server');
    fs.mkdirSync(path.join(this.root, 'runs'), { recursive: true });
    this.loadAll();
  }

  private loadAll() {
    const runsDir = path.join(this.root, 'runs');
    for (const id of fs.readdirSync(runsDir)) {
      const f = path.join(runsDir, id, 'run.json');
      if (!fs.existsSync(f)) continue;
      try {
        const run = JSON.parse(fs.readFileSync(f, 'utf8')) as RunRecord;
        // server 重启时不可能还有推进中的流水线，统一归为 blocked，可 continue
        if (run.status === 'running') {
          run.status = 'blocked';
          run.statusDetail = 'server 重启导致中断，可从当前阶段继续';
        }
        this.runs.set(id, run);
        this.seqs.set(id, this.lastSeq(id));
      } catch {
        /* 损坏的记录跳过 */
      }
    }
  }

  private lastSeq(id: string): number {
    const events = this.readEvents(id);
    return events.length ? events[events.length - 1].seq : 0;
  }

  runDir(id: string) {
    return path.join(this.root, 'runs', id);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** 是否已有同仓库的未完成运行（一个仓库同时只允许一条流水线） */
  activeRunForRepo(repoPath: string): RunRecord | undefined {
    return this.list().find(
      (r) => r.repoPath === repoPath && r.status !== 'done' && r.status !== 'failed',
    );
  }

  save(run: RunRecord) {
    run.updatedAt = new Date().toISOString();
    this.runs.set(run.id, run);
    const dir = this.runDir(run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  }

  event(run: RunRecord, type: RunEventType, data: Record<string, unknown>): RunEvent {
    const seq = (this.seqs.get(run.id) ?? 0) + 1;
    this.seqs.set(run.id, seq);
    const ev: RunEvent = { seq, ts: new Date().toISOString(), type, data };
    fs.appendFileSync(path.join(this.runDir(run.id), 'events.ndjson'), JSON.stringify(ev) + '\n');
    this.bus.emit('event', run.id, ev);
    return ev;
  }

  readEvents(id: string, afterSeq = 0): RunEvent[] {
    const f = path.join(this.runDir(id), 'events.ndjson');
    if (!fs.existsSync(f)) return [];
    const out: RunEvent[] = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as RunEvent;
        if (ev.seq > afterSeq) out.push(ev);
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  }
}
