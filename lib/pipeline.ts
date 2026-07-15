import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Lesson, ReviewFinding, RunRecord, StageName, StepKind } from './types';
import { Store } from './store';
import { exec, git, gh } from './exec';
import { runSdkEngine } from './sdkEngine';
import { runCodexSdkEngine } from './codexSdkEngine';
import * as P from './prompts';

/** 流水线主动停下（非异常崩溃）：没有人工兜底，一律终结为 failed，不支持 continue */
class Halt extends Error {}

/** 单边审查经 pipeline 裁决后的结果（origin 降级已完成） */
type EngineVerdict = { passed: boolean; mustFix: ReviewFinding[]; advisories: ReviewFinding[] };

const findingsText = (findings: ReviewFinding[]) =>
  findings.map((f) => `- [${f.file}]${f.reviewer ? ` (${f.reviewer})` : ''} ${f.issue}`).join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ci 阶段轮询的总时限：auto-merge 挂上后 harness 只是旁观者，给足慢 CI 的余量但不无限等 */
const CI_POLL_DEADLINE_MS = 6 * 3600_000;

const fmtDur = (a: string, b: string) => {
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

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

  /** 推进状态机直到：失败 / 完成。全自动，没有暂停点。支持从中断/失败处续跑（stage 已持久化）。 */
  async advance(): Promise<void> {
    this.setStatus('running');
    try {
      await this.prepareResume();
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
      // 复盘在 worktree 清理之前跑：终态无论成败都提炼经验（best effort，绝不影响运行结果）
      await this.stageRetro().catch((e) => this.log(`⚠ 复盘失败（不影响运行结果）：${e}`));
      await this.cleanupWorktree();
    }
  }

  // ---------------------------------------------------------- stages

  /**
   * 续跑准备：stage 已经过了 worktree 阶段、但 worktree 不在了（中断后被 cleanup 清掉），
   * 就从保留的分支重建 worktree 接着跑；worktree 还在但卡在 rebase 一半，先 abort 回到已提交状态。
   * 全新 run（stage=worktree）不受影响。
   */
  private async prepareResume() {
    if (this.run.stage === 'worktree') return;
    const wt = this.run.worktreePath;
    if (wt && fs.existsSync(wt)) {
      const gitDir = await this.gitDir();
      if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
        await git(this.repo, 'rebase', '--abort');
        this.log('⟲ 续跑：中断残留的 rebase 已 abort，回到已提交状态');
      }
      return;
    }
    if (!this.run.branch) throw new Halt('续跑失败：既没有 worktree 也没有分支记录，请重新 ship start');
    this.log(`⟲ 续跑：从分支 ${this.run.branch} 重建 worktree（从阶段 ${this.run.stage} 继续）`);
    const wtPath = path.join(this.store.runDir(this.run.id), 'worktree');
    const r = await git(this.originRepo, 'worktree', 'add', wtPath, this.run.branch);
    if (r.code !== 0) throw new Halt(`续跑重建 worktree 失败：${r.out}`);
    this.run.worktreePath = wtPath;
    this.store.save(this.run);
    await this.ensureShipExcluded();
  }

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
    // 先把暂存区里过往 run 的复盘经验同步进仓库（进本次 PR），再带着经验上下文开工
    await this.syncLessonsIntoRepo();
    const preCommits = Number((await git(this.repo, 'rev-list', '--count', `${this.cfg.base}..HEAD`)).out || '0');
    await this.engineRun(
      P.implementPrompt({
        branch: this.run.branch!,
        base: this.cfg.base,
        plan: this.run.plan,
        lessons: this.lessonsContext(),
      }),
      'implement',
      'implement',
    );
    await this.autoCommitIfDirty('ship: implement plan (auto-commit)');
    // 空实现门禁：引擎失败/没做事时，旧测试照样绿，不能放行（对比 lessons 同步等前置提交后的增量）
    const commits = Number((await git(this.repo, 'rev-list', '--count', `${this.cfg.base}..HEAD`)).out || '0');
    if (commits <= preCommits)
      throw new Halt('implement 结束但没有产生任何提交（引擎可能失败），运行终止');
    await this.gateTests();
  }

  private async stageAutoReview() {
    this.log(
      `阶段 autoReview：${this.cfg.reviewEngines.join(' + ')} 双边独立审查 ↔ 修复循环` +
        `（第 1 轮全量；第 2 轮起复审：打回方复核旧意见 + 放行方扫修复增量）`,
    );
    await this.assertOnFeatureBranch();
    this.run.reviewRound = 0;
    this.run.advisories = [];
    // 复审模式的输入：上一轮各 engine 的裁决 + 上一轮 fix 前的 HEAD（增量 diff 的基点）
    let prevVerdicts: Record<string, EngineVerdict> | null = null;
    let fixBaseSha: string | null = null;
    while (true) {
      this.run.reviewRound += 1;
      const round = this.run.reviewRound;
      this.store.save(this.run);
      if (round > this.cfg.maxReviewRounds)
        throw new Halt(`review 循环达到上限 ${this.cfg.maxReviewRounds} 轮仍未通过，运行终止`);
      this.log(`── review 第 ${round} 轮${round > 1 ? '（复审）' : '（全量）'}`);
      // 双边并行审查，全部结果到齐后统一裁决
      const verdicts: Record<string, EngineVerdict> =
        round === 1
          ? await this.runFullReview(round)
          : await this.runRecheckReview(round, prevVerdicts!, fixBaseSha!);
      const findings = Object.values(verdicts).flatMap((v) => v.mustFix);
      this.collectAdvisories(Object.values(verdicts).flatMap((v) => v.advisories));
      const passed = Object.values(verdicts).every((v) => v.passed);
      this.run.findings = findings;
      this.store.save(this.run);
      this.store.event(this.run, 'review', { round, passed, findings });
      if (passed) {
        this.log(`✔ 双边 review 均通过（第 ${round} 轮）`);
        return;
      }
      const text = findingsText(findings);
      this.log(`✖ ${findings.length} 个 must_fix 问题\n${text}`);
      if (round === this.cfg.maxReviewRounds) {
        // 终局轮的窄门补救：must_fix 全部是「旧意见未修净」时给一次锁定范围的追加修复；
        // 出现增量新问题 / 带 escape_reason 的旧范围严重问题（或第 1 轮即终局轮）则直接熔断，不变相加轮。
        if (!findings.every((f) => f.origin === 'previous'))
          throw new Halt(`review 终局轮（第 ${round} 轮）存在旧意见之外的 must_fix 新问题，运行终止\n${text}`);
        await this.rescueRound(round, verdicts);
        return;
      }
      fixBaseSha = (await git(this.repo, 'rev-parse', 'HEAD')).out;
      await this.engineRun(P.fixPrompt({ findings: text, plan: this.run.plan }), `fix-r${round}`, 'fix');
      await this.autoCommitIfDirty(`ship: fix review round ${round}`);
      await this.gateTests();
      prevVerdicts = verdicts;
    }
  }

  /** 按 reviewRoles 取该 engine 的审查分工文本（architecture / fidelity；未配置角色 → 通用审查） */
  private focusFor(engineName: string): string | undefined {
    const role = this.cfg.reviewRoles?.[engineName];
    return role ? P.REVIEW_FOCUS[role] : undefined;
  }

  /** 第 1 轮：reviewEngines 里每个 engine 各自对分支累计 diff 独立全量审查（按 reviewRoles 分工） */
  private async runFullReview(round: number): Promise<Record<string, EngineVerdict>> {
    const lessons = this.lessonsContext();
    const entries = await Promise.all(
      this.cfg.reviewEngines.map(async (name) => {
        const v = await this.reviewWithEngine(name, `review-${round}-${name}`, false, (reviewJson) =>
          P.reviewPrompt({
            base: this.cfg.base,
            reviewJson,
            plan: this.run.plan,
            lessons,
            focus: this.focusFor(name),
          }),
        );
        return [name, v] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * 第 2 轮起：上一轮打回方复核自己的意见 + 修复增量；放行方只扫修复增量
   * （增量为空时放行方直接视为通过，不烧一次 engine）。两边仍并行、仍是全新会话。
   */
  private async runRecheckReview(
    round: number,
    prev: Record<string, EngineVerdict>,
    fixBaseSha: string,
  ): Promise<Record<string, EngineVerdict>> {
    const deltaEmpty = (await git(this.repo, 'diff', '--quiet', `${fixBaseSha}...HEAD`)).code === 0;
    const entries = await Promise.all(
      this.cfg.reviewEngines.map(async (name) => {
        const rejected = prev[name] ? !prev[name].passed : false;
        if (!rejected && deltaEmpty) {
          this.log(`ℹ ${name} 上轮已放行且修复增量为空，跳过本轮审查`);
          return [name, { passed: true, mustFix: [], advisories: [] } satisfies EngineVerdict] as const;
        }
        const v = rejected
          ? await this.reviewWithEngine(name, `review-${round}-${name}-recheck`, true, (reviewJson) =>
              P.recheckPrompt({
                reviewJson,
                plan: this.run.plan,
                findings: findingsText(prev[name].mustFix),
                fixBaseSha,
                focus: this.focusFor(name),
              }),
            )
          : await this.reviewWithEngine(name, `review-${round}-${name}-delta`, true, (reviewJson) =>
              P.deltaReviewPrompt({ reviewJson, plan: this.run.plan, fixBaseSha, focus: this.focusFor(name) }),
            );
        return [name, v] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * 终局轮窄门补救（不占轮次）：must_fix 全部是「旧意见未修净」时追加一次修复，
   * 然后只由打回方对未解决项复核——修复范围锁死在旧意见上，放行方无需再看。
   * 复核后仍有任何 must_fix（含补救增量的新问题）即熔断。
   */
  private async rescueRound(round: number, verdicts: Record<string, EngineVerdict>) {
    const unresolved = Object.values(verdicts).flatMap((v) => v.mustFix);
    this.log(`── 终局轮补救：${unresolved.length} 条旧意见未修净，追加一次修复 + 打回方复核`);
    const fixBaseSha = (await git(this.repo, 'rev-parse', 'HEAD')).out;
    await this.engineRun(
      P.fixPrompt({ findings: findingsText(unresolved), plan: this.run.plan }),
      `fix-r${round}-rescue`,
      'fix',
    );
    await this.autoCommitIfDirty(`ship: fix review round ${round} (rescue)`);
    await this.gateTests();
    const rejectors = Object.entries(verdicts).filter(([, v]) => !v.passed);
    const results = await Promise.all(
      rejectors.map(async ([name, v]) => {
        return this.reviewWithEngine(name, `review-${round}-rescue-${name}`, true, (reviewJson) =>
          P.recheckPrompt({
            reviewJson,
            plan: this.run.plan,
            findings: findingsText(v.mustFix),
            fixBaseSha,
            focus: this.focusFor(name),
          }),
        );
      }),
    );
    const findings = results.flatMap((r) => r.mustFix);
    this.collectAdvisories(results.flatMap((r) => r.advisories));
    const passed = results.every((r) => r.passed);
    this.run.findings = findings;
    this.store.save(this.run);
    this.store.event(this.run, 'review', { round, passed, findings, rescue: true });
    if (!passed)
      throw new Halt(
        `终局轮补救后仍有 ${findings.length} 个 must_fix 未解决，运行终止\n${findingsText(findings)}`,
      );
    this.log('✔ 终局轮补救通过，双边 review 结清');
  }

  /** advisory 不阻塞流程：累计到 run 记录，stagePr 时附进 PR 描述留给人看 */
  private collectAdvisories(advisories: ReviewFinding[]) {
    if (!advisories.length) return;
    this.run.advisories = [...(this.run.advisories ?? []), ...advisories];
    this.log(`ℹ ${advisories.length} 条 advisory（不阻塞，将附在 PR 描述）\n${findingsText(advisories)}`);
  }

  /**
   * 跑一次单边审查并解析 review.json。
   * recheck=true 时执行复审收敛裁决（宽松版）：origin="other"（旧范围新发现）默认降级 advisory，
   * 除非审查者给出 escape_reason（为什么第 1 轮没发现、为什么必须现在阻塞）才保留 must_fix；
   * 该 engine 是否通过只看剩余 must_fix 是否为零（prompt 只是约定，裁决兜底在这里）。
   */
  private async reviewWithEngine(
    engineName: string,
    label: string,
    recheck: boolean,
    makePrompt: (reviewJson: string) => string,
  ): Promise<EngineVerdict> {
    const reviewJson = path.join(this.shipDir, `review-${engineName}.json`);
    fs.mkdirSync(this.shipDir, { recursive: true });
    fs.rmSync(reviewJson, { force: true });
    const prompt = makePrompt(reviewJson);
    await this.engineRun(prompt, label, 'review', engineName);
    if (!fs.existsSync(reviewJson)) {
      this.log(`⚠ ${engineName} 审查者没有写出 review.json，重试一次`);
      await this.engineRun(prompt, `${label}-retry`, 'review', engineName);
    }
    if (!fs.existsSync(reviewJson))
      throw new Halt(`${engineName} 审查者两次都未产出 review.json，运行终止`);
    let verdict: { pass?: boolean; findings?: ReviewFinding[] };
    try {
      verdict = JSON.parse(fs.readFileSync(reviewJson, 'utf8'));
    } catch (e) {
      throw new Halt(`${engineName} 的 review.json 不是合法 JSON：${e}`);
    }
    const all = (verdict.findings ?? []).map((f) => ({ ...f, reviewer: engineName }));
    const demote = (f: ReviewFinding) => recheck && f.origin === 'other' && !f.escape_reason?.trim();
    const advisories = all.filter((f) => f.must_fix === false || demote(f)).map((f) => ({ ...f, must_fix: false }));
    const mustFix = all.filter((f) => f.must_fix !== false && !demote(f));
    // 第 1 轮尊重审查者的 pass 结论（pass=false 却没给 must_fix 也算不过，防止空打回被放行）；
    // 复审轮以裁决后的 must_fix 为准：只剩降级 advisory 时按通过处理
    const passed = recheck ? mustFix.length === 0 : Boolean(verdict.pass) && mustFix.length === 0;
    if (recheck && verdict.pass === false && passed)
      this.log(`⚠ ${engineName} 判 pass=false 但阻塞项均为未给出阻塞理由的旧范围新发现（已降级 advisory），按通过处理`);
    return { passed, mustFix, advisories };
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
    const advisories = this.run.advisories ?? [];
    const advisorySection = advisories.length
      ? `\n\n## 审查备注（advisory，未阻塞合并）\n${findingsText(advisories).slice(0, 3000)}`
      : '';
    const body = `## 方案\n${this.run.plan.slice(0, 2000)}\n\n## 提交\n\`\`\`\n${commits}\n\`\`\`${advisorySection}\n\n🤖 opened by ship harness`;
    const created = await gh(this.repo, 'pr', 'create', '--base', this.cfg.base, '--title', title, '--body', body);
    if (created.code !== 0)
      throw new Halt(
        `gh pr create 失败（gh 未装/未登录/remote 不是 GitHub？）：${created.out}\n分支已 push，运行终止`,
      );
    this.run.prUrl = created.out.split('\n').pop() ?? null;
    this.store.save(this.run);
    this.log(`✔ PR 已创建：${this.run.prUrl}`);
  }

  /**
   * ci 阶段：先挂 GitHub auto-merge（squash），required check 一绿 GitHub 立即自动合并——
   * 不等非必需的慢 check、分支落后 base 但无冲突也照合（落后场景不做 update-branch 处理）。
   * harness 只轮询裁决三件事：PR 已合并（完成）、CI 失败（交 engine 修）、冲突（rebase 解决）。
   * 修复循环仍盯全部 check 的失败（非必需 check 挂了也修），但合并不等它们跑完。
   */
  private async stageCi() {
    this.log('阶段 ci：挂 auto-merge + CI/冲突轮询（代码裁决）');
    await this.armAutoMerge();
    let fixRound = 0;
    let noChecksRetries = 0;
    const deadline = Date.now() + CI_POLL_DEADLINE_MS;
    while (true) {
      if (await this.prMerged()) {
        this.log('✔ PR 已由 auto-merge 合并（required checks 全绿）');
        return;
      }
      if (Date.now() > deadline)
        throw new Halt(`ci 阶段超过 ${Math.round(CI_POLL_DEADLINE_MS / 3600_000)} 小时仍未合并，运行终止`);
      await this.resolveConflictsIfAny();
      const checks = await gh(this.repo, 'pr', 'checks');
      // push 刚发生时 Actions 可能还没注册 check：重试确认，避免把"还没开始"误判成"没配 CI"
      if (checks.out.toLowerCase().includes('no checks reported')) {
        if (++noChecksRetries <= 3) {
          this.log('… 还没有 check 上报，10s 后重试确认');
          await sleep(10_000);
          continue;
        }
        this.log('⚠ 确认该 PR 没有配置任何 CI check，视为通过');
        return;
      }
      noChecksRetries = 0;
      if (checks.code === 0) {
        this.log('✔ CI 全绿');
        return; // 没被 auto-merge 合掉（仓库未启用 auto-merge 等），由 stageMerge 兜底直接合
      }
      if (checks.code === 8) {
        // 还有 check 在跑且尚无失败：等 GitHub（auto-merge 可能随时把 PR 合掉）
        await sleep(30_000);
        continue;
      }
      fixRound += 1;
      if (fixRound > this.cfg.maxCiRounds)
        throw new Halt(`CI 修复达到上限 ${this.cfg.maxCiRounds} 轮仍未绿，运行终止`);
      this.log(`✖ CI 失败（第 ${fixRound} 轮），交给 engine 修复`);
      await this.engineRun(P.ciFixPrompt({ checks: checks.out.slice(-6000) }), `ci-fix-${fixRound}`, 'ciFix');
      await this.gateTests();
      await this.autoCommitIfDirty(`ship: fix CI (round ${fixRound})`);
      let r = await git(this.repo, 'push', 'origin', this.run.branch!);
      if (r.code !== 0) {
        r = await git(this.repo, 'push', '--force-with-lease', 'origin', this.run.branch!);
        if (r.code !== 0) throw new Halt(`push 失败：${r.out}`);
      }
      // auto-merge 在新 push 后仍保持开启（GitHub 只在 PR 关闭/base 变更时取消），无需重挂
    }
  }

  /**
   * 开启 GitHub 原生 auto-merge（squash）。这是"挂闹钟"不是合并动作本身——真正的合并
   * 由 GitHub 在 required checks 全绿后执行，或由 stageMerge 兜底。
   * 仓库未启用 auto-merge / PR 已处于可合并状态时开启会失败：降级为全绿后 stageMerge 直接合并。
   */
  private async armAutoMerge() {
    const r = await gh(this.repo, 'pr', 'merge', '--squash', '--auto');
    if (r.code === 0) {
      this.log('✔ 已开启 auto-merge（squash）：required checks 一绿 GitHub 立即自动合并，不等非必需 check');
      return;
    }
    this.log(`⚠ 开启 auto-merge 未成功（仓库未启用或 PR 已可直接合并），退回全绿后由 harness 合并：${r.out.slice(0, 200)}`);
  }

  private async prMerged(): Promise<boolean> {
    const r = await gh(this.repo, 'pr', 'view', '--json', 'state', '-q', '.state');
    return r.code === 0 && r.out.trim() === 'MERGED';
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
   * 合并兜底：auto-merge 已把 PR 合掉则直接放行；否则（仓库未启用 auto-merge 等）
   * 此刻 CI 已确认全绿，由 harness 调用一次 `gh pr merge --squash`。
   * 不带 --delete-branch：分支这时还在 worktree 里检出着，gh 删分支会跟这个冲突；
   * worktree 在 cleanup 阶段统一删（那时分支已经不在任何 worktree 里检出了）。
   */
  private async stageMerge() {
    if (await this.prMerged()) {
      this.log('✔ PR 已合并（auto-merge），merge 阶段无需动作');
      return;
    }
    this.log('阶段 merge：CI 已过，自动合并 PR');
    const r = await gh(this.repo, 'pr', 'merge', '--squash');
    if (r.code !== 0) throw new Halt(`自动合并 PR 失败：${r.out}`);
    this.log('✔ PR 已自动合并（squash）');
  }

  // ---------------------------------------------------------- lessons（复盘经验闭环）

  /** 仓库根的经验文件（进 git、团队共享）。.ship/ 被排除在提交外，所以放根目录。 */
  private get lessonsFile() {
    return path.join(this.repo, 'ship.lessons.md');
  }

  /**
   * 把 knowledge 暂存区里还没进仓库的经验同步进 ship.lessons.md 并单独 commit——
   * 一条 run 的复盘发生在它的 PR 合并之后，进不了自己的 PR，所以搭下一条 run 的车进 git。
   * 已出现在文件里的暂存条目（上一条 PR 已合并落盘）从暂存区清理；本次新写入的条目继续留在
   * 暂存区，万一这条 PR 最终没合并，再下一条 run 还会带上。
   * 同仓库并行 run 可能都同步同一批经验：文件冲突走既有 rebase 冲突流程，内容幂等可安全并两边。
   */
  private async syncLessonsIntoRepo() {
    const pending = this.store.pendingLessons(this.originRepo);
    if (!pending.length) return;
    const existing = fs.existsSync(this.lessonsFile) ? fs.readFileSync(this.lessonsFile, 'utf8') : '';
    const fresh = pending.filter((l) => !existing.includes(l.lesson));
    if (fresh.length < pending.length) this.store.rewritePendingLessons(this.originRepo, fresh);
    if (!fresh.length) return;
    const header =
      existing || '# ship lessons\n\nship harness 复盘自动累积的仓库级经验（供后续自动交付 run 避坑）。\n';
    const lines = fresh
      .map((l) => `- [${l.type}] ${l.lesson}${l.suggestion ? `（建议：${l.suggestion}）` : ''} <!-- ${l.runId} -->`)
      .join('\n');
    fs.writeFileSync(this.lessonsFile, `${header.replace(/\n?$/, '\n')}${lines}\n`);
    await git(this.repo, 'add', 'ship.lessons.md');
    const r = await git(this.repo, 'commit', '-m', 'ship: 同步过往运行的复盘经验（ship.lessons.md）');
    if (r.code !== 0) {
      this.log(`⚠ lessons 同步提交失败（不阻塞流程）：${r.out.slice(0, 200)}`);
      return;
    }
    this.log(`✔ 已同步 ${fresh.length} 条复盘经验进 ship.lessons.md（随本次 PR 进 git）`);
  }

  /** 注入 prompt 的经验上下文（implement 已先做同步，仓库文件即全集）；限长防挤占方案 */
  private lessonsContext(): string {
    if (!fs.existsSync(this.lessonsFile)) return '';
    return fs.readFileSync(this.lessonsFile, 'utf8').slice(-3500).trim();
  }

  /** 复盘补扫入口（server 启动时对"已终态但没总结过"的 run 批量补跑，保证不漏、不重） */
  async retroOnly() {
    if (this.run.status === 'running' || this.run.retroAt) return;
    await this.stageRetro().catch((e) => this.log(`⚠ 补扫复盘失败：${e}`));
  }

  /** 复盘完成的落账：run.json 打 retroAt 标记（判定源）+ knowledge/summarized.ndjson 台账（集中可查） */
  private markSummarized(lessonCount: number) {
    this.run.retroAt = new Date().toISOString();
    this.store.save(this.run);
    this.store.appendSummarized(this.originRepo, {
      runId: this.run.id,
      ts: this.run.retroAt,
      lessons: lessonCount,
    });
  }

  /**
   * run 终态后的复盘（best effort）：代码先把事件流压成执行摘要，engine 只做"错误→凝练经验"的提炼；
   * 产出存 run 记录（web 展示）+ knowledge 暂存区（下一条 run 同步进 git 并注入 prompt）。
   * 不依赖 worktree（补扫时 worktree 早已清理）：engine 在 runDir 里跑，只写 retro.json 一个文件。
   * retroAt 已存在的绝不重复总结。
   */
  private async stageRetro() {
    if (this.run.retroAt) return;
    if (!this.run.branch) {
      // 还没建出 worktree/分支就失败的 run（环境问题）没有可复盘的执行过程，直接落账防止反复补扫
      this.markSummarized(0);
      return;
    }
    this.log('阶段 retro：复盘本次执行，把犯过的错提炼成经验');
    const retroJson = path.join(this.store.runDir(this.run.id), 'retro.json');
    fs.rmSync(retroJson, { force: true });
    const known = [
      this.lessonsContext(),
      ...this.store.pendingLessons(this.originRepo).map((l) => `- [${l.type}] ${l.lesson}`),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(-3000);
    const cwd =
      this.run.worktreePath && fs.existsSync(this.run.worktreePath)
        ? this.run.worktreePath
        : this.store.runDir(this.run.id);
    await this.engineRun(
      P.retroPrompt({ retroJson, summary: this.buildRetroSummary(), knownLessons: known }),
      'retro',
      'retro',
      undefined,
      { cwd },
    );
    if (!fs.existsSync(retroJson)) {
      this.log('⚠ retro 未产出 retro.json，本次不留复盘经验');
      this.markSummarized(0);
      return;
    }
    let parsed: { lessons?: Lesson[] };
    try {
      parsed = JSON.parse(fs.readFileSync(retroJson, 'utf8'));
    } catch (e) {
      this.log(`⚠ retro.json 不是合法 JSON，本次不留复盘经验：${e}`);
      this.markSummarized(0);
      return;
    }
    const lessons = (parsed.lessons ?? [])
      .filter((l) => l && typeof l.lesson === 'string' && l.lesson.trim())
      .slice(0, 5)
      .map((l) => ({
        type: String(l.type ?? 'harness'),
        lesson: l.lesson.trim(),
        suggestion: l.suggestion?.trim() || undefined,
      }));
    this.run.lessons = lessons;
    this.markSummarized(lessons.length);
    if (!lessons.length) {
      this.log('ℹ 复盘完成：这次没有值得记的错');
      return;
    }
    const ts = this.run.retroAt!;
    this.store.appendPendingLessons(
      this.originRepo,
      lessons.map((l) => ({ ...l, runId: this.run.id, ts })),
    );
    this.log(
      `✔ 复盘提炼 ${lessons.length} 条经验（已入暂存区，随该仓库下一条 run 进 ship.lessons.md）\n` +
        lessons.map((l) => `- [${l.type}] ${l.lesson}`).join('\n'),
    );
  }

  /** 代码侧压缩事件流：阶段耗时、审查各轮结论、告警/失败行、advisory——retro engine 的唯一输入 */
  private buildRetroSummary(): string {
    const evs = this.store.readEvents(this.run.id);
    const lines: string[] = [
      `run: ${this.run.title}`,
      `终态: ${this.run.status}${this.run.statusDetail ? `（${this.run.statusDetail}）` : ''}`,
    ];
    let prevStage: string | null = null;
    let prevTs = this.run.createdAt;
    for (const ev of evs) {
      if (ev.type !== 'stage') continue;
      if (prevStage) lines.push(`阶段 ${prevStage} 耗时 ${fmtDur(prevTs, ev.ts)}`);
      prevStage = (ev.data as { stage?: string }).stage ?? null;
      prevTs = ev.ts;
    }
    if (prevStage) lines.push(`阶段 ${prevStage} 耗时 ${fmtDur(prevTs, this.run.updatedAt)}`);
    for (const ev of evs) {
      if (ev.type === 'review') {
        const d = ev.data as { round?: number; passed?: boolean; rescue?: boolean; findings?: ReviewFinding[] };
        const fs_ = d.findings ?? [];
        lines.push(`review 第 ${d.round} 轮${d.rescue ? '（补救）' : ''}：${d.passed ? '通过' : `${fs_.length} 个 must_fix`}`);
        for (const f of fs_.slice(0, 6))
          lines.push(`  - [${f.file}]（${f.reviewer ?? '?'}）${String(f.issue).slice(0, 160)}`);
      } else if (ev.type === 'log') {
        const msg = String((ev.data as { msg?: string }).msg ?? '');
        if (msg.startsWith('✖') || msg.startsWith('⚠')) lines.push(msg.split('\n')[0].slice(0, 200));
      }
    }
    const advisories = this.run.advisories ?? [];
    if (advisories.length) {
      lines.push(`advisory 共 ${advisories.length} 条：`);
      for (const f of advisories.slice(0, 6)) lines.push(`  - [${f.file}] ${String(f.issue).slice(0, 160)}`);
    }
    return lines.join('\n').slice(0, 6000);
  }

  // ---------------------------------------------------------- gates & engine

  private async detectTestCmd(): Promise<string | null> {
    if (this.cfg.testCmd) return this.cfg.testCmd;
    // implement 阶段 engine 按 implementPrompt 约定落的定向测试命令（monorepo 等自动探测不到的场景）
    const tcFile = path.join(this.shipDir, 'testcmd');
    if (fs.existsSync(tcFile)) {
      const cmd = fs
        .readFileSync(tcFile, 'utf8')
        .split('\n')
        .find((l) => l.trim())
        ?.trim();
      if (cmd) return cmd;
    }
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

  /**
   * codex 的 workspace-write 沙箱只放行 cwd、/tmp、$TMPDIR，而 worktree 的真实 git 元数据
   * 在主仓库 .git/ 下（沙箱外）——不加进可写目录，codex 在沙箱内的 git add/commit 一律
   * EPERM（headless 下 approval never，也没有升权通道可走）。
   * 普通仓库（git 元数据就在 <cwd>/.git）不加：codex 对它有意保持只读，交给 autoCommitIfDirty 兜底。
   */
  private async codexExtraWritableDirs(cwd: string): Promise<string[]> {
    const r = await git(cwd, 'rev-parse', '--git-common-dir');
    if (r.code !== 0) return [];
    const gitDir = path.resolve(cwd, r.out);
    const rel = path.relative(cwd, gitDir);
    const outsideCwd = rel.startsWith('..') || path.isAbsolute(rel);
    return outsideCwd ? [gitDir] : [];
  }

  private async autoCommitIfDirty(msg: string) {
    // 必须含未跟踪文件：codex 沙箱内 git add 会被拒（gitdir 在沙箱可写范围外），
    // engine 新增的文件只能靠这里兜底提交。.ship/ 用 pathspec 再排除一层，
    // 防 info/exclude 写入失败时把 harness 工作目录扫进提交。
    const dirty = (await git(this.repo, 'status', '--porcelain', '--', '.', ':!.ship')).out;
    if (!dirty) return;
    await git(this.repo, 'add', '-A', '--', '.', ':!.ship');
    await git(this.repo, 'commit', '-m', msg);
    this.log(`⚠ engine 留下未提交改动，已代为提交（${msg}）`);
  }

  /**
   * 调 LLM engine 做一步，输出全程落盘并实时推事件。
   * kind 用于 stageEngines 按步骤路由引擎；engineOverride 显式指定时优先于 kind 路由
   * （双边审查用它分别点名 reviewEngines 里的每个 engine）。
   */
  private async engineRun(
    prompt: string,
    label: string,
    kind: StepKind,
    engineOverride?: string,
    opts?: { cwd?: string },
  ): Promise<number> {
    const engineName = engineOverride ?? this.cfg.stageEngines?.[kind] ?? this.cfg.engine;
    const spec = this.cfg.engines[engineName];
    if (!spec) throw new Halt(`未知 engine: ${engineName}（步骤 ${kind}）`);
    const cwd = opts?.cwd ?? this.repo;

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
          ? await runSdkEngine({ prompt, cwd, spec, resume, onLine })
          : await runCodexSdkEngine({
              prompt,
              cwd,
              spec,
              resume,
              onLine,
              additionalDirectories: await this.codexExtraWritableDirs(cwd),
            });
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
      const child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
