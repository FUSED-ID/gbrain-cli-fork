/**
 * MinionSupervisor — Process manager for the Minion worker.
 *
 * Spawns `gbrain jobs work` as a child process and restarts it on crash
 * with exponential backoff. Provides health monitoring, PID file locking
 * (prevents duplicate supervisors), and graceful shutdown.
 *
 * Usage:
 *   gbrain jobs supervisor [--concurrency N] [--queue Q] [--pid-file PATH]
 *                          [--max-crashes N] [--health-interval N]
 *
 * Design: the supervisor does NOT run the worker in-process. It spawns a
 * separate child so a misbehaving handler can't take down the supervisor.
 * Same pattern as autopilot.ts but standalone and reusable.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import type { BrainEngine } from '../engine.ts';

export interface SupervisorOpts {
  /** Worker concurrency (passed to child). Default: 2. */
  concurrency: number;
  /** Queue name (passed to child). Default: 'default'. */
  queue: string;
  /** PID file path. Default: /tmp/gbrain-supervisor.pid. */
  pidFile: string;
  /** Max consecutive crashes before giving up. Default: 10. */
  maxCrashes: number;
  /** Health check interval in ms. Default: 60000. */
  healthInterval: number;
  /** Path to the gbrain CLI executable. */
  cliPath: string;
  /** Allow shell jobs on child worker. Default: true. */
  allowShellJobs: boolean;
}

const DEFAULTS: SupervisorOpts = {
  concurrency: 2,
  queue: 'default',
  pidFile: '/tmp/gbrain-supervisor.pid',
  maxCrashes: 10,
  healthInterval: 60_000,
  cliPath: '',
  allowShellJobs: true,
};

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[supervisor ${ts}] ${msg}`);
}

function warn(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.warn(`[supervisor ${ts}] ⚠ ${msg}`);
}

/** Calculate backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s cap. */
export function calculateBackoffMs(crashCount: number): number {
  const base = Math.min(1000 * Math.pow(2, crashCount), 60_000);
  // Add 10% jitter
  return base + Math.random() * base * 0.1;
}

/** Check if a PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class MinionSupervisor {
  private opts: SupervisorOpts;
  private engine: BrainEngine;
  private child: ChildProcess | null = null;
  private crashCount = 0;
  private lastStartTime = 0;
  private stopping = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: BrainEngine, opts: Partial<SupervisorOpts> & { cliPath: string }) {
    this.engine = engine;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Start the supervisor. Blocks until stopped or max crashes exceeded. */
  async start(): Promise<void> {
    // 1. PID file lock
    if (!this.acquirePidLock()) {
      return;
    }

    // Clean up PID file on any exit
    const cleanup = () => {
      try {
        if (existsSync(this.opts.pidFile)) {
          const contents = readFileSync(this.opts.pidFile, 'utf8').trim();
          if (contents === String(process.pid)) {
            unlinkSync(this.opts.pidFile);
          }
        }
      } catch { /* best effort */ }
    };
    process.on('exit', cleanup);

    // 2. Graceful shutdown
    const shutdown = async (sig: string) => {
      if (this.stopping) return;
      this.stopping = true;
      log(`Shutting down (${sig})`);

      if (this.healthTimer) {
        clearInterval(this.healthTimer);
        this.healthTimer = null;
      }

      if (this.child) {
        try { this.child.kill('SIGTERM'); } catch { /* already dead */ }
        await Promise.race([
          new Promise<void>(r => this.child!.once('exit', () => r())),
          new Promise<void>(r => setTimeout(() => r(), 35_000)),
        ]);
        if (this.child && !this.child.killed) {
          try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }

      log('Supervisor stopped.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // 3. Start health monitoring
    this.healthTimer = setInterval(() => this.healthCheck(), this.opts.healthInterval);

    // 4. Start worker loop
    log(`Starting (concurrency: ${this.opts.concurrency}, queue: ${this.opts.queue}, max-crashes: ${this.opts.maxCrashes})`);
    await this.spawnWorker();
  }

  /** Acquire PID file lock. Returns false if another supervisor is running. */
  private acquirePidLock(): boolean {
    if (existsSync(this.opts.pidFile)) {
      try {
        const existingPid = parseInt(readFileSync(this.opts.pidFile, 'utf8').trim(), 10);
        if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
          console.error(`Supervisor already running (PID: ${existingPid}). Exiting.`);
          return false;
        }
        // Stale PID file — remove it
        unlinkSync(this.opts.pidFile);
      } catch { /* corrupt file, proceed */ }
    }

    writeFileSync(this.opts.pidFile, String(process.pid));
    log(`PID file written: ${this.opts.pidFile} (PID: ${process.pid})`);
    return true;
  }

  /** Spawn the worker child process. Returns a promise that resolves when the child exits. */
  private spawnWorker(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopping) { resolve(); return; }

      const args = ['jobs', 'work', '--concurrency', String(this.opts.concurrency), '--queue', this.opts.queue];

      const env: Record<string, string | undefined> = { ...process.env };
      if (this.opts.allowShellJobs) {
        env.GBRAIN_ALLOW_SHELL_JOBS = '1';
      }

      this.lastStartTime = Date.now();
      const child = spawn(this.opts.cliPath, args, {
        stdio: 'inherit',
        env,
      });
      this.child = child;

      log(`Worker started (PID: ${child.pid})`);

      child.on('exit', async (code, signal) => {
        this.child = null;

        if (this.stopping) {
          resolve();
          return;
        }

        // Check if it ran long enough to reset crash counter
        const runDuration = Date.now() - this.lastStartTime;
        if (runDuration > 5 * 60 * 1000) {
          // Ran for >5 minutes — reset crash counter
          this.crashCount = 0;
        } else {
          this.crashCount++;
        }

        const exitReason = signal ? `signal ${signal}` : `code ${code}`;
        log(`Worker exited (${exitReason}), crash count: ${this.crashCount}/${this.opts.maxCrashes}`);

        if (this.crashCount >= this.opts.maxCrashes) {
          warn(`Max crashes (${this.opts.maxCrashes}) exceeded. Giving up.`);
          process.exit(1);
        }

        const backoff = calculateBackoffMs(this.crashCount - 1);
        log(`Restarting in ${Math.round(backoff)}ms...`);
        await new Promise(r => setTimeout(r, backoff));
        await this.spawnWorker();
        resolve();
      });
    });
  }

  /** Periodic health check — queries DB for queue health indicators. */
  private async healthCheck(): Promise<void> {
    try {
      // Check stalled count
      const stalledRows = await this.engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text as count FROM minion_jobs WHERE status = 'stalled'`,
        [],
      );
      const stalledCount = parseInt(stalledRows[0]?.count ?? '0', 10);

      // Check last completion time and waiting count
      const statusRows = await this.engine.executeRaw<{ last_completed: string | null; waiting_count: string }>(
        `SELECT
           (SELECT max(updated_at)::text FROM minion_jobs WHERE status = 'completed') as last_completed,
           (SELECT count(*)::text FROM minion_jobs WHERE status = 'waiting') as waiting_count`,
        [],
      );
      const lastCompleted = statusRows[0]?.last_completed ? new Date(statusRows[0].last_completed) : null;
      const waitingCount = parseInt(statusRows[0]?.waiting_count ?? '0', 10);

      // Check if worker process is alive
      const workerAlive = this.child != null && this.child.exitCode === null;

      // Emit health status
      const now = Date.now();
      const minutesSinceCompletion = lastCompleted ? Math.round((now - lastCompleted.getTime()) / 60_000) : null;

      if (stalledCount > 10) {
        warn(`${stalledCount} stalled jobs detected — worker may be unhealthy`);
      }

      if (waitingCount > 0 && minutesSinceCompletion !== null && minutesSinceCompletion > 30) {
        warn(`No completions in ${minutesSinceCompletion}min with ${waitingCount} waiting jobs — worker may be stuck`);
      }

      if (!workerAlive && !this.stopping) {
        warn(`Worker process not alive — should be restarting`);
      }
    } catch (e) {
      // Health check failures are non-fatal
      warn(`Health check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
