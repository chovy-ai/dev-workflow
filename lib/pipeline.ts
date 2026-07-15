import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ReviewFinding, RunRecord, StageName, StepKind } from './types';
import { Store } from './store';
import { exec, git, gh } from './exec';
import { runSdkEngine } from './sdkEngine';
import { runCodexSdkEngine } from './codexSdkEngine';
import * as P from './prompts';

/** 流水线主动停下（非异常崩溃）：没有人工兜底，一律终结为 failed，不支持 continue */
class Halt extends Error {}

export class Pipeline {
  constructor(
    private run: RunRecord,
    private store: Store,
  ) {}

  /** 原仓库路径：只用来管理 worktree 本身（add/remove）和最初的 fetch */
  private get originRepo() {
    return this.run.repoPath;
  }
  /** 实际工作目录：worktree 建好之前的兜底只在 stageWorktree 内部短暂生效 */
  private get repo() {
    return this.run.worktreePath ?? this.run.repoPath;
  }
  private get cfg() {
    return this.run.config;
  }
  private get shipDir() {
    return path.join(this.repo, '.ship');
  }

  private log(msg: string) {
    this.store.event(this.run, 'log', { msg });
  }

  private setStatus(status: RunRecord['status'], detail = '') {
    this.run.status = status;
    this.run.statusDetail = detail;
    this.store.save(this.run);
    this.store.event(this.run, 'status', { status, detail });
  }

  private setStage(stage: StageName) {
    this.run.stage = stage;
    this.store.save(this.run);
    this.store.event(this.run, 'stage', { stage });
  }

  /**
   * worktree 里 .git 是个指向真正 git-dir 的文件而非目录（`.git/worktrees/<name>`），
   * 不能直接拼 `<repo>/.git/...`——凡是要落到 git-dir 内部的路径（info/exclude、rebase 状态）都得
   * 先问 git 要实际 git-dir。
   */
  private async gitDir(): Promise<string> {
    const gd = (await git(this.repo, 'rev-parse', '--git-dir')).out;
    return path.isAbsolute(gd) ? gd : path.join(this.repo, gd);
  }

  /** .ship/ 是 harness 工作目录，绝不能进提交（engine 可能 git add -A） */
  private async ensureShipExcluded() {
    const exclude = path.join(await this.gitDir(), 'info', 'exclude');
    try {
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!cur.includes('.ship/')) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.writeFileSync(exclude, cur.replace(/\n?$/, '\n') + '.ship/\n');
      }
    } catch {
      /* exclude 写不进去不致命 */
    }
  }

  /** 推进状态机直到：失败 / 完成。全自动，没有暂停点。 */
  async advance(): Promise<void> {
    this.setStatus('running');
    try {
      while (true) {
        switch (this.run.stage) {
          case 'worktree':
            await this.stageWorktree();
            this.setStage('implement');
            break;
          case 'implement':
            await this.stageImplement();
            this.setStage('autoReview');
            break;
          case 'autoReview':
            await this.stageAutoReview();
            this.setStage('pr');
            break;
          case 'pr':
            await this.stagePr();
            this.setStage('ci');
            break;
          case 'ci':
            await this.stageCi();
            await this.stageMerge();
            this.setStage('done');
            break;
          case 'done':
            this.setStatus('done', '全自动完成：双边 LLM review 通过、测试/CI 绿、PR 已自动合并');
            this.log('✔ 全部完成（已自动合并 PR，无需人工操作）');
            return;
        }
      }
    } catch (e) {
      if (e instanceof Halt) {
        this.setStatus('failed', e.message);
        this.log(`✖ ${e.message}`);
      } else {
        this.setStatus('failed', String(e));
        this.store.event(this.run, 'error', { error: String(e) });
      }
    } finally {
      await this.cleanupWorktree();
    }
  }

  // ---------------------------------------------------------- stages

  /** 基于最新 origin/base 建 git worktree（不碰原仓库的工作目录，原仓库脏不脏都无所谓） */
  private async stageWorktree() {
    this.log(`阶段 worktree：基于最新 origin/${this.cfg.base} 建 git worktree`);
    await git(this.originRepo, 'fetch', 'origin');
    const name = this.branchName();
    const wtPath = path.join(this.store.runDir(this.run.id), 'worktree');
    let r = await git(this.originRepo, 'worktree', 'add', '-b', name, wtPath, `origin/${this.cfg.base}`);
    if (r.code !== 0)
      // 无远端 base（罕见）或分支名已存在时，退回：不新建分支、直接基于已有引用建 worktree
      r = await git(this.originRepo, 'worktree', 'add', wtPath, name);
    if (r.code !== 0) throw new Halt(`建 worktree 失败：${r.out}`);
    this.run.branch = name;
    this.run.worktreePath = wtPath;
    this.store.save(this.run);
    await this.ensureShipExcluded();
    this.log(`✔ worktree ${wtPath}（分支 ${name}）`);
  }

  /** 运行到终态（成功或失败）后清理 worktree，避免每次运行都在磁盘上留一份残留检出 */
  private async cleanupWorktree() {
    if (!this.run.worktreePath) return;
    const wt = this.run.worktreePath;
    this.log('阶段 cleanup：删除 worktree');
    const rm = await git(this.originRepo, 'worktree', 'remove', '--force', wt);
    if (rm.code !== 0) {
      // worktree 记录损坏等极端情况下的兜底：直接物理删除 + prune 清干净引用
      fs.rmSync(wt, { recursive: true, force: true });
      await git(this.originRepo, 'worktree', 'prune');
    }
    this.run.worktreePath = null;
    this.store.save(this.run);
    const branchNote =
      this.run.status === 'done'
        ? '（PR 已合并，分支可在 GitHub 上按仓库设置处理）'
        : `（分支 ${this.run.branch} 仍保留在原仓库，可用于排查失败原因）`;
    this.log(`✔ worktree 已删除 ${branchNote}`);
  }

  /**
   * 带 run id 后缀：同仓库现在允许并行跑多条 run，纯靠 plan 首行生成的名字可能撞车
   * （哪怕方案不同，首行标题一样就会撞）；run id 天然唯一，顺带也方便从分支名反查是哪条 run 建的。
   */
  private branchName(): string {
    const first = this.run.plan.split('\n').find((l) => l.trim()) ?? 'ship-work';
    const slug = first
      .toLowerCase()
      .replace(/^#+\s*/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const suffix = this.run.id.split('-').pop();
    return `feat/${slug || 'ship-work'}-${suffix}`;
  }

  private async assertOnFeatureBranch() {
    const cur = (await git(this.repo, 'branch', '--show-current')).out;
    if (cur === this.cfg.base)
      throw new Halt(`当前在 ${this.cfg.base} 上，拒绝继续（红线：不在基线分支上改动）`);
  }

  private async stageImplement() {
    this.log('阶段 implement：engine 按方案实现，测试门禁放行');
    await this.assertOnFeatureBranch();
    await this.engineRun(
      P.implementPrompt({ branch: this.run.branch!, base: this.cfg.base, plan: this.run.plan }),
      'implement',
      'implement',
    );
    await this.autoCommitIfDirty('ship: implement plan (auto-commit)');
    // 空实现门禁：引擎失败/没做事时，旧测试照样绿，不能放行
    const commits = (await git(this.repo, 'rev-list', '--count', `${this.cfg.base}..HEAD`)).out;
    if (commits === '0')
      throw new Halt('implement 结束但没有产生任何提交（引擎可能失败），运行终止');
    await this.gateTests();
  }

  private async stageAutoReview() {
    this.log(`阶段 autoReview：${this.cfg.reviewEngines.join(' + ')} 双边独立审查 ↔ 修复循环（任一方打回即不通过）`);
    await this.assertOnFeatureBranch();
    this.run.reviewRound = 0;
    while (true) {
      this.run.reviewRound += 1;
      const round = this.run.reviewRound;
      this.store.save(this.run);
      if (round > this.cfg.maxReviewRounds)
        throw new Halt(`review 循环达到上限 ${this.cfg.maxReviewRounds} 轮仍未通过，运行终止`);
      this.log(`── review 第 ${round} 轮`);
      const { passed, findings } = await this.runReview(round);
      this.run.findings = findings;
      this.store.save(this.run);
      this.store.event(this.run, 'review', { round, passed, findings });
      if (passed) {
        this.log(`✔ 双边 review 均通过（第 ${round} 轮）`);
        return;
      }
      const text = findings.map((f) => `- [${f.file}]${f.reviewer ? ` (${f.reviewer})` : ''} ${f.issue}`).join('\n');
      this.log(`✖ ${findings.length} 个 must_fix 问题\n${text}`);
      await this.engineRun(P.fixPrompt({ findings: text, plan: this.run.plan }), `fix-r${round}`, 'fix');
      await this.autoCommitIfDirty(`ship: fix review round ${round}`);
      await this.gateTests();
    }
  }

  /** 双边独立审查：reviewEngines 里每个 engine 各自独立跑一遍，全部通过才算这一轮通过 */
  private async runReview(round: number): Promise<{ passed: boolean; findings: ReviewFinding[] }> {
    const results = await Promise.all(
      this.cfg.reviewEngines.map((engineName) => this.runReviewWithEngine(engineName, round)),
    );
    const findings = results.flatMap((r) => r.findings);
    const passed = results.every((r) => r.passed);
    return { passed, findings };
  }

  private async runReviewWithEngine(
    engineName: string,
    round: number,
  ): Promise<{ passed: boolean; findings: ReviewFinding[] }> {
    const reviewJson = path.join(this.shipDir, `review-${engineName}.json`);
    fs.mkdirSync(this.shipDir, { recursive: true });
    fs.rmSync(reviewJson, { force: true });
    const prompt = P.reviewPrompt({ base: this.cfg.base, reviewJson, plan: this.run.plan });
    await this.engineRun(prompt, `review-${round}-${engineName}`, 'review', engineName);
    if (!fs.existsSync(reviewJson)) {
      this.log(`⚠ ${engineName} 审查者没有写出 review.json，重试一次`);
      await this.engineRun(prompt, `review-${round}-${engineName}-retry`, 'review', engineName);
    }
    if (!fs.existsSync(reviewJson))
      throw new Halt(`${engineName} 审查者两次都未产出 review.json，运行终止`);
    let verdict: { pass?: boolean; findings?: ReviewFinding[] };
    try {
      verdict = JSON.parse(fs.readFileSync(reviewJson, 'utf8'));
    } catch (e) {
      throw new Halt(`${engineName} 的 review.json 不是合法 JSON：${e}`);
    }
    const findings = (verdict.findings ?? [])
      .filter((f) => f.must_fix !== false)
      .map((f) => ({ ...f, reviewer: engineName }));
    return { passed: Boolean(verdict.pass) && findings.length === 0, findings };
  }

  private async stagePr() {
    this.log(`阶段 pr：push + 开 PR（base: ${this.cfg.base}）`);
    await this.assertOnFeatureBranch();
    const branch = this.run.branch!;
    let r = await git(this.repo, 'push', '-u', 'origin', branch);
    if (r.code !== 0) r = await git(this.repo, 'push', '--force-with-lease', 'origin', branch);
    if (r.code !== 0) throw new Halt(`push 失败：${r.out}`);
    this.log('✔ 已 push');

    const view = await gh(this.repo, 'pr', 'view', '--json', 'url', '-q', '.url');
    if (view.code === 0 && view.out) {
      this.run.prUrl = view.out;
      this.store.save(this.run);
      this.log(`✔ PR 已存在（push 即已更新）：${view.out}`);
      return;
    }
    const title =
      this.run.plan
        .split('\n')
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, '') ?? branch;
    const commits = (await git(this.repo, 'log', '--oneline', `${this.cfg.base}..HEAD`)).out;
    const body = `## 方案\n${this.run.plan.slice(0, 2000)}\n\n## 提交\n\`\`\`\n${commits}\n\`\`\`\n\n🤖 opened by ship harness`;
    const created = await gh(this.repo, 'pr', 'create', '--base', this.cfg.base, '--title', title, '--body', body);
    if (created.code !== 0)
      throw new Halt(
        `gh pr create 失败（gh 未装/未登录/remote 不是 GitHub？）：${created.out}\n分支已 push，运行终止`,
      );
    this.run.prUrl = created.out.split('\n').pop() ?? null;
    this.store.save(this.run);
    this.log(`✔ PR 已创建：${this.run.prUrl}`);
  }

  private async stageCi() {
    this.log('阶段 ci：CI / 冲突循环（代码轮询与裁决）');
    for (let round = 1; round <= this.cfg.maxCiRounds; round++) {
      await this.resolveConflictsIfAny();
      let watch = await gh(this.repo, 'pr', 'checks', '--watch');
      // push 刚发生时 Actions 可能还没注册 check：重试确认，避免把"还没开始"误判成"没配 CI"
      for (let retry = 0; retry < 3 && watch.out.toLowerCase().includes('no checks reported'); retry++) {
        this.log('… 还没有 check 上报，10s 后重试确认');
        await new Promise((r) => setTimeout(r, 10_000));
        watch = await gh(this.repo, 'pr', 'checks', '--watch');
      }
      if (watch.code === 0) {
        this.log('✔ CI 全绿');
        return;
      }
      if (watch.out.toLowerCase().includes('no checks reported')) {
        this.log('⚠ 确认该 PR 没有配置任何 CI check，视为通过');
        return;
      }
      this.log(`✖ CI 失败（第 ${round} 轮），交给 engine 修复`);
      const checks = (await gh(this.repo, 'pr', 'checks')).out;
      await this.engineRun(P.ciFixPrompt({ checks: checks.slice(-6000) }), `ci-fix-${round}`, 'ciFix');
      await this.gateTests();
      await this.autoCommitIfDirty(`ship: fix CI (round ${round})`);
      let r = await git(this.repo, 'push', 'origin', this.run.branch!);
      if (r.code !== 0) {
        r = await git(this.repo, 'push', '--force-with-lease', 'origin', this.run.branch!);
        if (r.code !== 0) throw new Halt(`push 失败：${r.out}`);
      }
    }
    throw new Halt(`CI 修复达到上限 ${this.cfg.maxCiRounds} 轮仍未绿，运行终止`);
  }

  private async resolveConflictsIfAny() {
    const m = await gh(this.repo, 'pr', 'view', '--json', 'mergeable', '-q', '.mergeable');
    if (m.code !== 0 || m.out !== 'CONFLICTING') return;
    this.log(`PR 与 ${this.cfg.base} 冲突，rebase 处理`);
    await git(this.repo, 'fetch', 'origin');
    const r = await git(this.repo, 'rebase', `origin/${this.cfg.base}`);
    if (r.code !== 0) {
      await this.engineRun(P.conflictPrompt({ base: this.cfg.base, plan: this.run.plan }), 'conflicts', 'conflict');
      const gitDir = await this.gitDir();
      const midRebase =
        fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
      if (midRebase) {
        await git(this.repo, 'rebase', '--abort');
        throw new Halt('engine 未能完成冲突解决，已 rebase --abort 恢复现场，运行终止');
      }
    }
    await this.gateTests();
    const push = await git(this.repo, 'push', '--force-with-lease', 'origin', this.run.branch!);
    if (push.code !== 0) throw new Halt(`冲突解决后 push 失败：${push.out}`);
    this.log('✔ 冲突已解决并推送');
  }

  /**
   * CI 已确认全绿后自动合并 PR：squash 到 base。
   * 不带 --delete-branch：分支这时还在 worktree 里检出着，gh 删分支会跟这个冲突；
   * worktree 在 cleanup 阶段统一删（那时分支已经不在任何 worktree 里检出了）。
   */
  private async stageMerge() {
    this.log('阶段 merge：CI 已过，自动合并 PR');
    const r = await gh(this.repo, 'pr', 'merge', '--squash');
    if (r.code !== 0) throw new Halt(`自动合并 PR 失败：${r.out}`);
    this.log('✔ PR 已自动合并（squash）');
  }

  // ---------------------------------------------------------- gates & engine

  private async detectTestCmd(): Promise<string | null> {
    if (this.cfg.testCmd) return this.cfg.testCmd;
    const has = (f: string) => fs.existsSync(path.join(this.repo, f));
    if (has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.repo, 'package.json'), 'utf8'));
        if (pkg.scripts?.test) return 'npm test';
      } catch {
        /* ignore */
      }
    }
    if (has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(this.repo, 'Makefile'), 'utf8')))
      return 'make test';
    if (has('pytest.ini') || has('tests')) return 'python3 -m pytest -q';
    if (has('tests.py')) return 'python3 tests.py';
    return null;
  }

  /** 代码门禁：测试不绿不放行；失败交 engine 修，封顶 maxFixRounds */
  private async gateTests() {
    const cmd = await this.detectTestCmd();
    if (!cmd) {
      this.log('⚠ 未探测到测试命令（可在配置里指定 testCmd），跳过测试门禁');
      return;
    }
    for (let attempt = 0; attempt <= this.cfg.maxFixRounds; attempt++) {
      const r = await exec(cmd, this.repo);
      if (r.code === 0) {
        this.log(`✔ 测试通过（${cmd}）`);
        return;
      }
      if (attempt === this.cfg.maxFixRounds)
        throw new Halt(`测试修复 ${attempt} 轮后仍失败，运行终止。最后输出：\n${r.out.slice(-3000)}`);
      this.log(`✖ 测试失败（第 ${attempt + 1} 次），交给 engine 修复`);
      await this.engineRun(
        P.testFixPrompt({ testCmd: cmd, output: r.out.slice(-6000) }),
        `test-fix-${attempt + 1}`,
        'testFix',
      );
      await this.autoCommitIfDirty(`ship: fix failing tests (attempt ${attempt + 1})`);
    }
  }

  private async autoCommitIfDirty(msg: string) {
    const dirty = (await git(this.repo, 'status', '--porcelain', '--untracked-files=no')).out;
    if (!dirty) return;
    await git(this.repo, 'add', '-u');
    await git(this.repo, 'commit', '-m', msg);
    this.log(`⚠ engine 留下未提交改动，已代为提交（${msg}）`);
  }

  /**
   * 调 LLM engine 做一步，输出全程落盘并实时推事件。
   * kind 用于 stageEngines 按步骤路由引擎；engineOverride 显式指定时优先于 kind 路由
   * （双边审查用它分别点名 reviewEngines 里的每个 engine）。
   */
  private async engineRun(prompt: string, label: string, kind: StepKind, engineOverride?: string): Promise<number> {
    const engineName = engineOverride ?? this.cfg.stageEngines?.[kind] ?? this.cfg.engine;
    const spec = this.cfg.engines[engineName];
    if (!spec) throw new Halt(`未知 engine: ${engineName}（步骤 ${kind}）`);

    const logsDir = path.join(this.store.runDir(this.run.id), 'engine-logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `${Date.now()}-${label}.log`);
    fs.writeFileSync(logFile, `--- prompt ---\n${prompt}\n--- output ---\n`);

    this.store.event(this.run, 'engine', { label, state: 'start', engine: engineName });
    this.log(`⤷ engine[${engineName}] ${label} …`);

    if (!Array.isArray(spec)) {
      // —— SDK 引擎（进程内：claude-sdk / codex-sdk）——
      // 工作线程（实现/修复/CI修复/解冲突）续用同一会话，修复时带着实现的上下文；
      // review 必须全新会话——独立审查的价值就在于没有实现过程的上下文。
      // 会话按引擎名分桶：claude 的 session_id 和 codex 的 thread_id 不通用。
      this.run.sdkSessions ??= {};
      const resume = kind === 'review' ? null : (this.run.sdkSessions[engineName] ?? null);
      const onLine = (line: string) => {
        fs.appendFileSync(logFile, line + '\n');
        this.store.event(this.run, 'engine-line', { label, line });
      };
      const res =
        spec.type === 'claude-sdk'
          ? await runSdkEngine({ prompt, cwd: this.repo, spec, resume, onLine })
          : await runCodexSdkEngine({ prompt, cwd: this.repo, spec, resume, onLine });
      if (kind !== 'review' && res.sessionId) {
        this.run.sdkSessions[engineName] = res.sessionId;
        this.store.save(this.run);
      }
      this.store.event(this.run, 'engine', { label, state: 'end', code: res.code });
      if (res.code !== 0) this.log(`⚠ engine 退出码 ${res.code}（继续由门禁判定实际结果）`);
      return res.code;
    }

    // —— 外部 CLI 引擎（codex / claude-cli / 自定义命令）——
    const cmd = spec.map((a) => (a === '{prompt}' ? prompt : a));
    return new Promise((resolve) => {
      // stdin 显式关闭：claude -p 等 CLI 会等 stdin 3s 才继续
      const child = spawn(cmd[0], cmd.slice(1), { cwd: this.repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      const onChunk = (chunk: Buffer) => {
        fs.appendFileSync(logFile, chunk);
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines)
          if (line.trim()) this.store.event(this.run, 'engine-line', { label, line });
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (err) => {
        this.store.event(this.run, 'engine', { label, state: 'end', code: 127 });
        this.log(`⚠ engine 启动失败：${err}`);
        resolve(127);
      });
      child.on('close', (code) => {
        this.store.event(this.run, 'engine', { label, state: 'end', code });
        if (code !== 0) this.log(`⚠ engine 退出码 ${code}（继续由门禁判定实际结果）`);
        resolve(code ?? 1);
      });
    });
  }
}
