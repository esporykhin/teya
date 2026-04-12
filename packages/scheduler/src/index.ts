/**
 * @description Public API for @teya/scheduler
 *
 * Library exports (used by CLI):
 * - TaskStore, createTaskTools — task management
 * - createIPCClient, HealthManager — daemon communication
 * - handleSchedulerCommand — CLI subcommands
 *
 * Daemon entry point: ./daemon.ts (separate build target)
 */
export { TaskStore, type Task, type TaskStatus, type TaskPriority, type CreateTaskInput, type UpdateTaskInput, type TaskQuery, type ExecutionRecord } from './task-store.js'
export { CronEngine, type CronEngineExecutor, matchCron, matchField, getTimeInTimezone, isCronDueInTimezone, hasMissedWindow } from './cron-engine.js'
export { DaemonExecutor, type DaemonExecutorConfig, type BuiltinHandler } from './daemon-executor.js'
export { createTaskTools } from './tools.js'
export { HealthManager } from './health.js'
export { IPCServer, IPCClient, createIPCClient, type IPCRequest, type IPCResponse, type DaemonStatus } from './ipc.js'
export { handleSchedulerCommand, ensureSchedulerRunning, type EnsureSchedulerResult } from './cli.js'
export { ensureBuiltinTasks, BUILTIN_TASKS, type BuiltinTaskDef } from './builtin-tasks.js'
