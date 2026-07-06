#!/usr/bin/env python3
"""ship — 方案 → PR 的代码化交付 harness。

流程控制、门禁判定（测试 / review 结论 / CI / 冲突）、循环上限全部由本脚本裁决；
LLM（claude code 或 codex）只被调用来完成单个步骤：实现、修复、独立审查、解冲突。

用法（在目标 git 仓库根目录运行）:
  ship.py start --plan plan.md     从一份已确认的方案开始，走完全流程
  ship.py continue                 从上次停下的阶段继续（CI 挂了修完续跑等）
  ship.py reject "审查意见..."      打回：把意见交给 LLM 修复，然后重新进入复审循环
  ship.py status                   查看当前所处阶段与仓库状态
  ship.py init                     生成 ship.config.json 配置模板

阶段: branch → implement → review(循环) → pr → ci(循环) → done(等人工合并)
退出码: 0 完成/绿  2 需要人工决策  3 环境阻塞(缺 gh 等)  1 其他错误
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SHIP_DIR = ".ship"
STAGES = ["branch", "implement", "review", "pr", "ci", "done"]

DEFAULT_CONFIG = {
    "engine": "claude",
    "base": "main",
    "test_cmd": None,  # null = 自动探测（npm test / make test / pytest / tests.py）
    "max_review_rounds": 3,
    "max_ci_rounds": 3,
    "max_fix_rounds": 3,
    "engines": {
        # headless 下 engine 需要能编辑文件、跑测试、git commit；
        # 嫌宽可在 ship.config.json 里收紧 allowedTools，或换成受控容器里跑
        "claude": ["claude", "--permission-mode", "acceptEdits",
                   "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
                   "-p", "{prompt}"],
        "codex": ["codex", "exec", "--full-auto", "{prompt}"],
    },
}

# ---------------------------------------------------------------- prompts

IMPLEMENT_PROMPT = """按以下已确认的方案在当前仓库实现。约束：
- 你在分支 {branch} 上，不要切换分支、不要动 {base} 分支、不要 push、不要 merge。
- 方案未覆盖的细节遵循仓库现有惯例。
- 如果发现方案有硬伤（无法实现、前提错误），在输出中明确说明并停止，不要自作主张改方案。
- 按逻辑单元 git commit（只提交到本地）。

=== 已确认的方案 ===
{plan}
"""

REVIEW_PROMPT = """你是一名独立代码审查者，没有参与实现，用全新视角审查一个改动。
待审改动 = `git diff {base}...HEAD`（自行运行查看，可进一步阅读仓库文件、运行测试来求证）。
只报告真问题：真实 bug、与方案的偏差、缺失的关键测试、未处理的边界条件。不要报风格/偏好类意见。

审查结论必须以 JSON 写入文件 {review_json} ，格式：
{{"pass": true 或 false, "findings": [{{"file": "路径", "issue": "问题描述", "must_fix": true 或 false}}]}}
判定标准：不存在 must_fix 的问题即 pass=true。除写这一个文件外，不要修改任何代码。

=== 方案原文 ===
{plan}
"""

FIX_PROMPT = """在当前分支修复以下审查意见。修复后运行测试自证，然后按逻辑单元 git commit。
不要切换分支、不要 push、不要 merge、不要顺手做无关改动。

=== 待修复的意见 ===
{findings}

=== 方案原文（供理解意图）===
{plan}
"""

TEST_FIX_PROMPT = """当前分支的本地测试失败了。定位并修复，修完重新运行测试确认通过，然后 git commit。
不要切换分支、不要 push、不要 merge、不要为了绿灯而弱化/删除测试（除非测试本身写错了，且要说明理由）。

=== 测试命令 ===
{test_cmd}

=== 失败输出 ===
{output}
"""

CI_FIX_PROMPT = """PR 的 CI 失败了。用 `gh pr checks`、`gh run view --log-failed` 调查根因，
在本地修复并用仓库自己的测试方式验证，然后 git commit。
不要 push（由 harness 统一推送）、不要 merge、不要为了绿灯而屏蔽检查项。

=== 失败概要 ===
{checks}
"""

CONFLICT_PROMPT = """仓库正处于 rebase 冲突状态（正在 rebase 到 origin/{base}）。
解决所有冲突：既尊重方案的意图，也尊重 {base} 上新变更的意图，两边都要保留其本意。
每解决一个文件 `git add`，然后 `git rebase --continue`，直到 rebase 全部完成。
不要 `git rebase --abort`、不要 push。

=== 方案原文 ===
{plan}
"""

# ---------------------------------------------------------------- helpers


def sh(cmd, cwd=None, check=False, capture=True):
    """Run a command; return (rc, stdout+stderr)."""
    r = subprocess.run(
        cmd, cwd=cwd, capture_output=capture, text=True, shell=isinstance(cmd, str)
    )
    out = ((r.stdout or "") + (r.stderr or "")).strip() if capture else ""
    if check and r.returncode != 0:
        die(f"命令失败: {cmd}\n{out}")
    return r.returncode, out


def die(msg, code=1):
    print(f"\n✖ {msg}", file=sys.stderr)
    sys.exit(code)


def banner(msg):
    print(f"\n{'=' * 60}\n▶ {msg}\n{'=' * 60}")


class Ship:
    def __init__(self, repo: Path):
        self.repo = repo
        rc, top = sh(["git", "rev-parse", "--show-toplevel"], cwd=repo)
        if rc != 0:
            die("当前目录不是 git 仓库")
        self.repo = Path(top)
        self.dir = self.repo / SHIP_DIR
        self.cfg = self._load_config()
        self.state = self._load_state()
        self._exclude_ship_dir()

    # -------------------------------------------------- config / state

    def _load_config(self):
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
        f = self.repo / "ship.config.json"
        if f.exists():
            user = json.loads(f.read_text())
            engines = {**cfg["engines"], **user.get("engines", {})}
            cfg.update(user)
            cfg["engines"] = engines
        return cfg

    def _load_state(self):
        f = self.dir / "state.json"
        if f.exists():
            return json.loads(f.read_text())
        return {"stage": None, "branch": None, "review_round": 0, "ci_round": 0, "feedback": []}

    def _save_state(self):
        self.dir.mkdir(exist_ok=True)
        (self.dir / "state.json").write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2)
        )

    def _exclude_ship_dir(self):
        exclude = self.repo / ".git" / "info" / "exclude"
        try:
            content = exclude.read_text() if exclude.exists() else ""
            if SHIP_DIR + "/" not in content:
                exclude.parent.mkdir(parents=True, exist_ok=True)
                exclude.write_text(content.rstrip("\n") + f"\n{SHIP_DIR}/\n")
        except OSError:
            pass

    @property
    def plan(self):
        f = self.dir / "plan.md"
        if not f.exists():
            die("没有找到方案（.ship/plan.md）。先用 ship.py start --plan <file> 开始。")
        return f.read_text()

    # -------------------------------------------------- git facts

    def git(self, *args, check=False):
        return sh(["git", *args], cwd=self.repo, check=check)

    @property
    def base(self):
        return self.cfg["base"]

    @property
    def branch(self):
        return self.git("branch", "--show-current")[1]

    def dirty(self):
        # 只看已跟踪文件：未跟踪文件（配置、临时产物）不应阻塞流程
        return bool(self.git("status", "--porcelain", "--untracked-files=no")[1])

    def assert_on_feature_branch(self):
        if self.branch == self.base:
            die(f"当前在 {self.base} 上，拒绝继续（红线：不在基线分支上做任何改动）", 2)

    # -------------------------------------------------- engine

    def engine_run(self, prompt: str, label: str):
        name = self.cfg["engine"]
        tmpl = self.cfg["engines"].get(name)
        if not tmpl:
            die(f"未知 engine: {name}（可在 ship.config.json 的 engines 里定义）", 3)
        if not shutil.which(tmpl[0]):
            die(f"找不到命令 {tmpl[0]}，请安装或检查 PATH", 3)
        cmd = [prompt if a == "{prompt}" else a for a in tmpl]

        n = self.state.get("engine_calls", 0) + 1
        self.state["engine_calls"] = n
        self._save_state()
        logf = self.dir / "logs" / f"{n:03d}-{label}.log"
        logf.parent.mkdir(parents=True, exist_ok=True)

        print(f"  ⤷ engine[{name}] {label} …（日志 {logf.relative_to(self.repo)}）")
        with open(logf, "w") as fh:
            fh.write(f"$ {' '.join(cmd[:-1])} <prompt>\n--- prompt ---\n{prompt}\n--- output ---\n")
            fh.flush()
            r = subprocess.run(cmd, cwd=self.repo, stdout=fh, stderr=subprocess.STDOUT, text=True)
        if r.returncode != 0:
            print(f"  ⚠ engine 退出码 {r.returncode}（详见日志），继续由门禁判定实际结果")
        return r.returncode

    # -------------------------------------------------- gates (code-decided)

    def detect_test_cmd(self):
        if self.cfg.get("test_cmd"):
            return self.cfg["test_cmd"]
        r = self.repo
        pkg = r / "package.json"
        if pkg.exists():
            try:
                if json.loads(pkg.read_text()).get("scripts", {}).get("test"):
                    return "npm test"
            except json.JSONDecodeError:
                pass
        mk = r / "Makefile"
        if mk.exists() and re.search(r"^test:", mk.read_text(), re.M):
            return "make test"
        if (r / "pytest.ini").exists() or (r / "tests").is_dir():
            return "python3 -m pytest -q"
        if (r / "tests.py").exists():
            return "python3 tests.py"
        return None

    def gate_tests(self):
        """代码门禁：测试不绿不放行。失败则让 engine 修，封顶 max_fix_rounds。"""
        cmd = self.detect_test_cmd()
        if not cmd:
            print("  ⚠ 未探测到测试命令（可在 ship.config.json 里配 test_cmd），跳过测试门禁")
            return
        for attempt in range(self.cfg["max_fix_rounds"] + 1):
            rc, out = sh(cmd, cwd=self.repo)
            if rc == 0:
                print(f"  ✔ 测试通过（{cmd}）")
                return
            if attempt == self.cfg["max_fix_rounds"]:
                die(f"测试修复 {attempt} 轮后仍失败，需要人工介入。\n最后输出：\n{out[-3000:]}", 2)
            print(f"  ✖ 测试失败（第 {attempt + 1} 次），交给 engine 修复")
            self.engine_run(
                TEST_FIX_PROMPT.format(test_cmd=cmd, output=out[-6000:]),
                f"test-fix-{attempt + 1}",
            )

    def run_review(self):
        """独立审查一轮，返回 (passed, findings)。结论由 JSON 文件回传、代码裁决。"""
        review_json = self.dir / "review.json"
        review_json.unlink(missing_ok=True)
        self.engine_run(
            REVIEW_PROMPT.format(base=self.base, review_json=review_json, plan=self.plan),
            f"review-{self.state['review_round']}",
        )
        if not review_json.exists():
            print("  ⚠ 审查者没有写出 review.json，重试一次")
            self.engine_run(
                REVIEW_PROMPT.format(base=self.base, review_json=review_json, plan=self.plan),
                f"review-{self.state['review_round']}-retry",
            )
        if not review_json.exists():
            die("审查者两次都未产出 review.json，需要人工介入", 2)
        try:
            verdict = json.loads(review_json.read_text())
        except json.JSONDecodeError as e:
            die(f"review.json 不是合法 JSON：{e}，需要人工介入", 2)
        findings = verdict.get("findings", [])
        must_fix = [f for f in findings if f.get("must_fix", True)]
        passed = bool(verdict.get("pass")) and not must_fix
        return passed, must_fix

    # -------------------------------------------------- stages

    def stage_branch(self):
        banner(f"阶段 1/5 建分支（基于最新 origin/{self.base}）")
        if self.branch != self.base:
            print(f"  已在分支 {self.branch}，跳过")
            self.state["branch"] = self.branch
            return
        if self.dirty():
            die(f"{self.base} 上有未提交改动，请先处理（stash 或 commit 到别处）", 2)
        self.git("fetch", "origin")
        name = self.state.get("branch") or self._branch_name()
        rc, out = self.git("checkout", "-b", name, f"origin/{self.base}")
        if rc != 0:
            rc, out = self.git("checkout", "-b", name)  # 无 origin/<base> 时退回本地 base
            if rc != 0:
                die(f"建分支失败：{out}")
        self.state["branch"] = name
        print(f"  ✔ 分支 {name}")

    def _branch_name(self):
        first = next((l for l in self.plan.splitlines() if l.strip()), "ship-work")
        slug = re.sub(r"[^a-z0-9]+", "-", first.lower().lstrip("# ").strip()).strip("-")[:40]
        return f"feat/{slug or 'ship-work'}"

    def stage_implement(self):
        banner("阶段 2/5 实现（engine 执行，测试门禁放行）")
        self.assert_on_feature_branch()
        self.engine_run(
            IMPLEMENT_PROMPT.format(branch=self.branch, base=self.base, plan=self.plan),
            "implement",
        )
        if self.dirty():
            print("  ⚠ engine 留下未提交改动，代为提交")
            self.git("add", "-A")
            self.git("commit", "-m", "ship: implement plan (auto-commit)")
        rc, _ = self.git("rev-list", "--count", f"{self.base}..HEAD")
        self.gate_tests()

    def stage_review(self):
        banner("阶段 3/5 独立审查 ↔ 修复循环（代码裁决通过与否）")
        self.assert_on_feature_branch()
        # 轮数只在本次循环内累积；continue/人工介入后重新进入即重置，避免立刻再次熔断
        self.state["review_round"] = 0
        # 打回的意见（用户 reject）先修再审
        if self.state["feedback"]:
            fb = "\n".join(f"- {x}" for x in self.state["feedback"])
            print("  ⤷ 先处理打回意见")
            self.engine_run(FIX_PROMPT.format(findings=fb, plan=self.plan), "rework-fix")
            self.state["feedback"] = []
            self._save_state()
            self.gate_tests()
        while True:
            self.state["review_round"] += 1
            rnd = self.state["review_round"]
            self._save_state()
            if rnd > self.cfg["max_review_rounds"]:
                die(f"review 循环达到上限 {self.cfg['max_review_rounds']} 轮仍未通过，"
                    f"剩余问题见 .ship/review.json，需要人工决策", 2)
            print(f"  ── review 第 {rnd} 轮")
            passed, findings = self.run_review()
            if passed:
                print(f"  ✔ review 通过（第 {rnd} 轮）")
                self.state["review_round"] = 0
                self._save_state()
                return
            text = "\n".join(f"- [{f.get('file', '?')}] {f.get('issue', '')}" for f in findings)
            print(f"  ✖ {len(findings)} 个 must_fix 问题：\n{text}")
            self.engine_run(FIX_PROMPT.format(findings=text, plan=self.plan), f"fix-r{rnd}")
            self.gate_tests()

    def stage_pr(self):
        banner(f"阶段 4/5 push + 开 PR（base: {self.base}）")
        self.assert_on_feature_branch()
        rc, out = self.git("push", "-u", "origin", self.branch)
        if rc != 0:
            rc, out = self.git("push", "--force-with-lease", "origin", self.branch)
            if rc != 0:
                die(f"push 失败：{out}", 3)
        print("  ✔ 已 push")
        if not shutil.which("gh"):
            die("未安装 gh CLI，无法开 PR。分支已 push，装好 gh 后运行 ship.py continue", 3)
        rc, _ = sh(["gh", "pr", "view", "--json", "url"], cwd=self.repo)
        if rc == 0:
            print("  ✔ PR 已存在，push 即已更新")
            return
        title = next((l.lstrip("# ").strip() for l in self.plan.splitlines() if l.strip()), self.branch)
        _, commits = self.git("log", "--oneline", f"{self.base}..HEAD")
        body = f"## 方案\n{self.plan[:2000]}\n\n## 提交\n```\n{commits}\n```\n\n🤖 opened by ship harness"
        rc, out = sh(["gh", "pr", "create", "--base", self.base, "--title", title, "--body", body],
                     cwd=self.repo)
        if rc != 0:
            die(f"gh pr create 失败（remote 不是 GitHub / 未 gh auth login？）：\n{out}\n"
                f"分支已 push，处理好后运行 ship.py continue", 3)
        print(f"  ✔ PR 已创建：{out.splitlines()[-1] if out else ''}")

    def stage_ci(self):
        banner("阶段 5/5 CI / 冲突循环（代码轮询与裁决）")
        for rnd in range(1, self.cfg["max_ci_rounds"] + 1):
            self._resolve_conflicts_if_any()
            rc, out = sh(["gh", "pr", "checks", "--watch"], cwd=self.repo)
            if rc == 0:
                print("  ✔ CI 全绿")
                return
            if "no checks reported" in out.lower():
                print("  ⚠ 该 PR 没有配置任何 CI check，视为通过")
                return
            print(f"  ✖ CI 失败（第 {rnd} 轮），交给 engine 修复")
            _, checks = sh(["gh", "pr", "checks"], cwd=self.repo)
            self.engine_run(CI_FIX_PROMPT.format(checks=checks[-6000:]), f"ci-fix-{rnd}")
            self.gate_tests()
            if self.dirty():
                self.git("add", "-A")
                self.git("commit", "-m", f"ship: fix CI (round {rnd})")
            rc, out = self.git("push", "origin", self.branch)
            if rc != 0:
                self.git("push", "--force-with-lease", "origin", self.branch, check=True)
        die(f"CI 修复达到上限 {self.cfg['max_ci_rounds']} 轮仍未绿，需要人工介入", 2)

    def _resolve_conflicts_if_any(self):
        rc, out = sh(["gh", "pr", "view", "--json", "mergeable", "-q", ".mergeable"], cwd=self.repo)
        if rc != 0 or out != "CONFLICTING":
            return
        print(f"  ⤷ PR 与 {self.base} 冲突，rebase 处理")
        self.git("fetch", "origin", check=True)
        rc, _ = self.git("rebase", f"origin/{self.base}")
        if rc != 0:  # 有冲突，engine 解决
            self.engine_run(CONFLICT_PROMPT.format(base=self.base, plan=self.plan), "conflicts")
            if (self.repo / ".git" / "rebase-merge").exists() or (self.repo / ".git" / "rebase-apply").exists():
                self.git("rebase", "--abort")
                die("engine 未能完成冲突解决，已 rebase --abort 恢复现场，需要人工处理", 2)
        self.gate_tests()
        self.git("push", "--force-with-lease", "origin", self.branch, check=True)
        print("  ✔ 冲突已解决并推送")

    def stage_done(self):
        banner("完成：等待人工合并（harness 永不 merge）")
        rc, url = sh(["gh", "pr", "view", "--json", "url", "-q", ".url"], cwd=self.repo)
        if rc == 0:
            print(f"  PR: {url}\n  review/CI 均已通过，请人工审阅并合并。")

    # -------------------------------------------------- drivers

    def run_from(self, stage):
        for s in STAGES[STAGES.index(stage):]:
            self.state["stage"] = s
            self._save_state()
            if s != "done":
                getattr(self, f"stage_{s}")()
        self.stage_done()
        self.state["stage"] = "done"
        self._save_state()

    def cmd_start(self, plan_file, branch):
        p = Path(plan_file)
        if not p.exists():
            die(f"方案文件不存在: {plan_file}")
        self.dir.mkdir(exist_ok=True)
        shutil.copy(p, self.dir / "plan.md")
        self.state = {"stage": "branch", "branch": branch, "review_round": 0,
                      "ci_round": 0, "feedback": [], "engine_calls": 0}
        self._save_state()
        self.run_from("branch")

    def cmd_continue(self):
        stage = self.state.get("stage")
        if not stage or stage == "done":
            die("没有进行中的流程（或已完成）。用 start 开始新流程。", 2)
        print(f"从阶段 {stage} 继续")
        self.run_from(stage)

    def cmd_reject(self, feedback):
        if self.branch == self.base:
            die(f"当前在 {self.base} 上，没有可打回的工作分支", 2)
        self.state["feedback"].append(feedback)
        self.state["review_round"] = 0
        self._save_state()
        print("已记录打回意见 → 修复 → 复审循环 → （若有 PR）push 更新 → CI")
        self.run_from("review")

    def cmd_status(self):
        print(f"仓库      : {self.repo}")
        print(f"分支      : {self.branch}（base: {self.base}）")
        print(f"阶段      : {self.state.get('stage') or '未开始'}")
        print(f"工作区    : {'有未提交改动' if self.dirty() else '干净'}")
        print(f"engine    : {self.cfg['engine']}")
        print(f"测试命令  : {self.detect_test_cmd() or '未探测到'}")
        if self.state.get("feedback"):
            print(f"待处理打回: {len(self.state['feedback'])} 条")
        rc, out = sh(["gh", "pr", "view", "--json", "url,state,mergeable",
                      "-q", '"\\(.url) \\(.state) \\(.mergeable)"'], cwd=self.repo)
        print(f"PR        : {out if rc == 0 else '无（或 gh 不可用）'}")


def cmd_init(repo: Path):
    f = repo / "ship.config.json"
    if f.exists():
        die(f"{f} 已存在")
    f.write_text(json.dumps(
        {k: v for k, v in DEFAULT_CONFIG.items()}, ensure_ascii=False, indent=2))
    print(f"已生成 {f}，按需修改 engine/base/test_cmd")


def main():
    ap = argparse.ArgumentParser(description="ship — 方案→PR 交付 harness")
    ap.add_argument("-C", "--repo", default=".", help="目标仓库路径（默认当前目录）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_start = sub.add_parser("start", help="从已确认的方案开始")
    p_start.add_argument("--plan", required=True, help="方案 markdown 文件")
    p_start.add_argument("--branch", help="指定分支名（默认从方案标题生成）")
    sub.add_parser("continue", help="从上次停下的阶段继续")
    p_rej = sub.add_parser("reject", help="打回：附意见重新进入修复-复审循环")
    p_rej.add_argument("feedback", help="审查意见")
    sub.add_parser("status", help="查看状态")
    sub.add_parser("init", help="生成配置模板")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if args.cmd == "init":
        return cmd_init(repo)
    ship = Ship(repo)
    if args.cmd == "start":
        ship.cmd_start(args.plan, args.branch)
    elif args.cmd == "continue":
        ship.cmd_continue()
    elif args.cmd == "reject":
        ship.cmd_reject(args.feedback)
    elif args.cmd == "status":
        ship.cmd_status()


if __name__ == "__main__":
    main()
