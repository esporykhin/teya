/**
 * @description Public API for @teya/scheduler
 *
 * Library exports (used by CLI):
 * - TaskStore, createTaskTools — task management
 * - createIPCClient — daemon RPC communication
 * - handleSchedulerCommand, ensureSchedulerRunning — CLI subcommands + auto-bootstrap
 *
 * Daemon entry point: ./daemon.ts (separate build target).
 *
 * Process lifecycle (PID, heartbeat, restart) is owned by @teya/runtime —
 * scheduler does NOT maintain its own PID files anymore.
 */
export { TaskStore, type Task, type TaskStatus, type TaskPriority, type CreateTaskInput, type UpdateTaskInput, type TaskQuery, type ExecutionRecord } from './task-store.js'
export { CronEngine, type CronEngineExecutor, matchCron, matchField, getTimeInTimezone, isCronDueInTimezone, hasMissedWindow } from './cron-engine.js'
export { DaemonExecutor, type DaemonExecutorConfig, type BuiltinHandler } from './daemon-executor.js'
export { createTaskTools } from './tools.js'
export { IPCServer, IPCClient, createIPCClient, type IPCRequest, type IPCResponse, type DaemonStatus } from './ipc.js'
export { handleSchedulerCommand, ensureSchedulerRunning, type EnsureSchedulerResult } from './cli.js'
export { ensureBuiltinTasks, BUILTIN_TASKS, type BuiltinTaskDef } from './builtin-tasks.js'
