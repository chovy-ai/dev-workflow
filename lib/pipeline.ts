import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ReviewFinding, RunRecord, StageName, StepKind } from './types';
import { Store } from './store';
import { exec, git, gh } from './exec';
import { runSdkEngine } from './sdkEngine';
import { runCodexSdkEngine } from './codexSdkEngine';
import * as P from './prompts';

/** 流水线主动停下（非异常崩溃）：blocked=需人工处理后 continue；awaiting=等 web review */
class Halt extends Error {
  constructor(
    public kind: 'blocked' | 'failed',
    msg: string,
  ) {
    super(msg);
  }
}

export class Pipeline {
  constructor(
    private run: RunRecord,
    private store: Store,
  ) {}

  private get repo() {
    return this.run.repoPath;
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

  /** .ship/ 是 harness 工作目录，绝不能进提交（engine 可能 git add -A） */
  private ensureShipExcluded() {
    const exclude = path.join(this.repo, '.git', 'info', 'exclude');
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

  /** 推进状态机直到：暂停（人工门禁）/ 阻塞 / 失败 / 完成 */
  async advance(): Promise<void> {
    this.ensureShipExcluded();
    this.setStatus('running');
    try {
      while (true) {
        switch (this.run.stage) {
          case 'branch':
            await this.stageBranch();
            this.setStage('implement');
            break;
          case 'implement':
            await this.stageImplement();
            this.setStage('autoReview');
            break;
          case 'autoReview':
            await this.stageAutoReview();
            this.setStage('humanReview');
            break;
          case 'humanReview':
            // 人工门禁：停住，等 web/cli 的 approve 或 reject
            this.setStatus('awaiting_review', '等待人工 review：通过 → 提 PR；打回 → 修复后复审');
            return;
          case 'pr':
            await this.stagePr();
            this.setStage('ci');
            break;
          case 'ci':
            await this.stageCi();
            this.setStage('done');
            break;
          case 'done':
            this.setStatus('done', 'review/CI 已过，等待人工合并 PR');
            this.log('✔ 全部完成，请在 GitHub 上人工审阅并合并 PR');
            return;
        }
      }
    } catch (e) {
      if (e instanceof Halt) {
        this.setStatus(e.kind === 'blocked' ? 'blocked' : 'failed', e.message);
        this.log(`✖ ${e.message}`);
      } else {
        this.setStatus('failed', String(e));
        this.store.event(this.run, 'error', { error: String(e) });
      }
    }
  }

  // ---------------------------------------------------------- stages

  private async stageBranch() {
    this.log(`阶段 branch：基于最新 origin/${this.cfg.base} 建分支`);
    const cur = (await git(this.repo, 'branch', '--show-current')).out;
    if (cur && cur !== this.cfg.base) {
      this.log(`已在分支 ${cur}，跳过建分支`);
      this.run.branch = cur;
      this.store.save(this.run);
      return;
    }
    const dirty = (await git(this.repo, 'status', '--porcelain', '--untracked-files=no')).out;
    if (dirty) throw new Halt('blocked', `${this.cfg.base} 上有未提交改动，请先处理再 continue`);
    await git(this.repo, 'fetch', 'origin');
    const name = this.run.branch ?? this.branchName();
    let r = await git(this.repo, 'checkout', '-b', name, `origin/${this.cfg.base}`);
    if (r.code !== 0) r = await git(this.repo, 'checkout', '-b', name); // 无远端 base 时退回本地
    if (r.code !== 0) throw new Halt('failed', `建分支失败：${r.out}`);
    this.run.branch = name;
    this.store.save(this.run);
    this.log(`✔ 分支 ${name}`);
  }

  private branchName(): string {
    const first = this.run.plan.split('\n').find((l) => l.trim()) ?? 'ship-work';
    const slug = first
      .toLowerCase()
      .replace(/^#+\s*/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `feat/${slug || 'ship-work'}`;
  }

  private async assertOnFeatureBranch() {
    const cur = (await git(this.repo, 'branch', '--show-current')).out;
    if (cur === this.cfg.base)
      throw new Halt('blocked', `当前在 ${this.cfg.base} 上，拒绝继续（红线：不在基线分支上改动）`);
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
      throw new Halt('blocked', 'implement 结束但没有产生任何提交（引擎可能失败），检查引擎输出后 continue 重试');
    await this.gateTests();
  }

  private async stageAutoReview() {
    this.log('阶段 autoReview：独立 LLM 审查 ↔ 修复循环（代码裁决）');
    await this.assertOnFeatureBranch();
    // 人工打回的意见先修再审
    if (this.run.feedback.length) {
      const fb = this.run.feedback.map((x) => `- ${x}`).join('\n');
      this.log('先处理打回意见');
      await this.engineRun(P.fixPrompt({ findings: fb, plan: this.run.plan }), 'rework-fix', 'fix');
      this.run.feedback = [];
      this.store.save(this.run);
      await this.autoCommitIfDirty('ship: address human review feedback');
      await this.gateTests();
    }
    // 轮数只在本次循环内累积：熔断→人工介入→continue 后重新获得完整预算
    this.run.reviewRound = 0;
    while (true) {
      this.run.reviewRound += 1;
      const round = this.run.reviewRound;
      this.store.save(this.run);
      if (round > this.cfg.maxReviewRounds)
        throw new Halt(
          'blocked',
          `review 循环达到上限 ${this.cfg.maxReviewRounds} 轮仍未通过，需要人工决策（可打回附意见或 continue 重试）`,
        );
      this.log(`── review 第 ${round} 轮`);
      const { passed, findings } = await this.runReview(round);
      this.run.findings = findings;
      this.store.save(this.run);
      this.store.event(this.run, 'review', { round, passed, findings });
      if (passed) {
        this.log(`✔ LLM review 通过（第 ${round} 轮）`);
        return;
      }
      const text = findings.map((f) => `- [${f.file}] ${f.issue}`).join('\n');
      this.log(`✖ ${findings.length} 个 must_fix 问题\n${text}`);
      await this.engineRun(P.fixPrompt({ findings: text, plan: this.run.plan }), `fix-r${round}`, 'fix');
      await this.autoCommitIfDirty(`ship: fix review round ${round}`);
      await this.gateTests();
    }
  }

  private async runReview(round: number): Promise<{ passed: boolean; findings: ReviewFinding[] }> {
    const reviewJson = path.join(this.shipDir, 'review.json');
    fs.mkdirSync(this.shipDir, { recursive: true });
    fs.rmSync(reviewJson, { force: true });
    const prompt = P.reviewPrompt({ base: this.cfg.base, reviewJson, plan: this.run.plan });
    await this.engineRun(prompt, `review-${round}`, 'review');
    if (!fs.existsSync(reviewJson)) {
      this.log('⚠ 审查者没有写出 review.json，重试一次');
      await this.engineRun(prompt, `review-${round}-retry`, 'review');
    }
    if (!fs.existsSync(reviewJson))
      throw new Halt('blocked', '审查者两次都未产出 review.json，需要人工介入');
    let verdict: { pass?: boolean; findings?: ReviewFinding[] };
    try {
      verdict = JSON.parse(fs.readFileSync(reviewJson, 'utf8'));
    } catch (e) {
      throw new Halt('blocked', `review.json 不是合法 JSON：${e}`);
    }
    const findings = (verdict.findings ?? []).filter((f) => f.must_fix !== false);
    return { passed: Boolean(verdict.pass) && findings.length === 0, findings };
  }

  private async stagePr() {
    this.log(`阶段 pr：push + 开 PR（base: ${this.cfg.base}）`);
    await this.assertOnFeatureBranch();
    const branch = this.run.branch!;
    let r = await git(this.repo, 'push', '-u', 'origin', branch);
    if (r.code !== 0) r = await git(this.repo, 'push', '--force-with-lease', 'origin', branch);
    if (r.code !== 0) throw new Halt('blocked', `push 失败：${r.out}`);
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
        'blocked',
        `gh pr create 失败（gh 未装/未登录/remote 不是 GitHub？）：${created.out}\n分支已 push，处理好后 continue`,
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
        if (r.code !== 0) throw new Halt('blocked', `push 失败：${r.out}`);
      }
    }
    throw new Halt('blocked', `CI 修复达到上限 ${this.cfg.maxCiRounds} 轮仍未绿，需要人工介入`);
  }

  private async resolveConflictsIfAny() {
    const m = await gh(this.repo, 'pr', 'view', '--json', 'mergeable', '-q', '.mergeable');
    if (m.code !== 0 || m.out !== 'CONFLICTING') return;
    this.log(`PR 与 ${this.cfg.base} 冲突，rebase 处理`);
    await git(this.repo, 'fetch', 'origin');
    const r = await git(this.repo, 'rebase', `origin/${this.cfg.base}`);
    if (r.code !== 0) {
      await this.engineRun(P.conflictPrompt({ base: this.cfg.base, plan: this.run.plan }), 'conflicts', 'conflict');
      const midRebase =
        fs.existsSync(path.join(this.repo, '.git', 'rebase-merge')) ||
        fs.existsSync(path.join(this.repo, '.git', 'rebase-apply'));
      if (midRebase) {
        await git(this.repo, 'rebase', '--abort');
        throw new Halt('blocked', 'engine 未能完成冲突解决，已 rebase --abort 恢复现场，需要人工处理');
      }
    }
    await this.gateTests();
    const push = await git(this.repo, 'push', '--force-with-lease', 'origin', this.run.branch!);
    if (push.code !== 0) throw new Halt('blocked', `冲突解决后 push 失败：${push.out}`);
    this.log('✔ 冲突已解决并推送');
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
        throw new Halt('blocked', `测试修复 ${attempt} 轮后仍失败，需要人工介入。最后输出：\n${r.out.slice(-3000)}`);
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

  /** 调 LLM engine 做一步，输出全程落盘并实时推事件。kind 用于 stageEngines 按步骤路由引擎 */
  private async engineRun(prompt: string, label: string, kind: StepKind): Promise<number> {
    const engineName = this.cfg.stageEngines?.[kind] ?? this.cfg.engine;
    const spec = this.cfg.engines[engineName];
    if (!spec) throw new Halt('blocked', `未知 engine: ${engineName}（步骤 ${kind}）`);

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
