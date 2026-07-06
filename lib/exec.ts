import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  out: string; // stdout + stderr 合并
}

/** 运行命令（数组=直接 spawn；字符串=经 shell），捕获输出。 */
export function exec(
  cmd: string[] | string,
  cwd: string,
  opts?: { onLine?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = Array.isArray(cmd)
      ? spawn(cmd[0], cmd.slice(1), { cwd })
      : spawn(cmd, { cwd, shell: true });

    let out = '';
    let buf = '';
    const onChunk = (chunk: Buffer) => {
      const s = chunk.toString();
      out += s;
      if (opts?.onLine) {
        buf += s;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) opts.onLine(line);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      out += String(err);
      resolve({ code: 127, out: out.trim() });
    });
    child.on('close', (code) => {
      if (opts?.onLine && buf) opts.onLine(buf);
      resolve({ code: code ?? 1, out: out.trim() });
    });
  });
}

export const git = (repo: string, ...args: string[]) => exec(['git', ...args], repo);
export const gh = (repo: string, ...args: string[]) => exec(['gh', ...args], repo);
