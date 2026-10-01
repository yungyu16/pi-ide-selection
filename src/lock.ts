/**
 * Claude Code IDE 插件的 lock 文件发现与选路。
 *
 * 插件为每个已打开的项目写 `~/.claude/ide/<port>.lock`：文件名即监听端口，内容含
 * `authToken` 和 `workspaceFolders`。同一 IDE 进程打开多个项目时共享 pid、各有
 * 独立端口，因此必须按 cwd 选路，选错端口会拿到别的项目的选区。
 *
 * 本模块只读不写：lock 的生命周期归 Claude Code 插件，绝不代为清理。
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 当前只实现 `ws`；协议里还预留了 `sse`，遇到时按不支持处理。 */
export type IdeTransport = "ws" | "sse" | (string & {});

export interface LockInfo {
  port: number;
  pid?: number;
  ideName?: string;
  transport?: IdeTransport;
  runningInWindows?: boolean;
  authToken?: string;
  workspaceFolders: string[];
}

const LOCK_DIR = join(homedir(), ".claude", "ide");

/** 协议未公开，所有字段按 optional 容错，不认识的字段忽略。 */
function parseLock(fileName: string, raw: string): LockInfo | null {
  const port = Number(fileName.replace(/\.lock$/, ""));
  if (!Number.isInteger(port) || port <= 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const folders = Array.isArray(record.workspaceFolders)
    ? record.workspaceFolders.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

  return {
    port,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    ideName: typeof record.ideName === "string" ? record.ideName : undefined,
    transport: typeof record.transport === "string" ? record.transport : undefined,
    runningInWindows: typeof record.runningInWindows === "boolean" ? record.runningInWindows : undefined,
    authToken: typeof record.authToken === "string" ? record.authToken : undefined,
    workspaceFolders: folders,
  };
}

/** 目录不存在/无权限时视为无可用 lock，不抛错。 */
export async function readLocks(): Promise<LockInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(LOCK_DIR);
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    entries
      .filter((name) => name.endsWith(".lock"))
      .map(async (name) => {
        try {
          return parseLock(name, await readFile(join(LOCK_DIR, name), "utf-8"));
        } catch {
          return null;
        }
      }),
  );
  return parsed.filter((lock): lock is LockInfo => lock !== null);
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户，仍算存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function covers(folder: string, cwd: string): boolean {
  const normalized = folder.endsWith("/") ? folder : `${folder}/`;
  return cwd === folder || cwd.startsWith(normalized);
}

/** lock 是否可连：ws 传输、有 token、pid 存活且覆盖 cwd。 */
function isConnectable(lock: LockInfo, cwd: string): boolean {
  return (
    lock.transport === "ws" &&
    typeof lock.authToken === "string" &&
    lock.authToken.length > 0 &&
    isPidAlive(lock.pid) &&
    lock.workspaceFolders.some((folder) => covers(folder, cwd))
  );
}

function matchDepth(lock: LockInfo, cwd: string): number {
  const depths = lock.workspaceFolders.filter((f) => covers(f, cwd)).map((f) => f.length);
  return depths.length > 0 ? Math.max(...depths) : -1;
}

/**
 * 从 lock 列表里挑出覆盖 cwd 的那一个，多个候选取最长（最精确）匹配。
 *
 * 匹配不到就返回 null —— 宁可不连，也不猜端口。
 */
export function pickLock(locks: LockInfo[], cwd: string): LockInfo | null {
  const candidates = locks.filter((lock) => isConnectable(lock, cwd));
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => matchDepth(b, cwd) - matchDepth(a, cwd) || b.port - a.port,
  )[0]!;
}
