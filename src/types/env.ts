// ⬛⬜🛣️ BlackRoad Workers Environment Types

export interface Env {
  // Durable Objects
  AGENT_COORDINATOR: DurableObjectNamespace;
  REPO_SCRAPER: DurableObjectNamespace;
  TASK_QUEUE: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;
  SYNC_MANAGER: DurableObjectNamespace;

  // KV Namespaces
  CACHE: KVNamespace;
  REPO_DATA: KVNamespace;
  AGENT_STATE: KVNamespace;

  // D1 Database
  DB: D1Database;

  // R2 Buckets
  MEDIA_BUCKET: R2Bucket;
  ARTIFACTS_BUCKET: R2Bucket;

  // Queues
  TASK_QUEUE_PRODUCER: Queue;
  SYNC_QUEUE_PRODUCER: Queue;

  // Environment Variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  BLACKROAD_ORG: string;
  SELF_HEAL_ENABLED: string;
  AUTO_SYNC_ENABLED: string;
  MAX_RETRY_ATTEMPTS: string;
  RETRY_BACKOFF_MS: string;
  TRACKED_REPOS: string;

  // Secrets (set via wrangler secret)
  GITHUB_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
  WEBHOOK_SECRET?: string;
}

export interface AgentTask {
  id: string;
  type: AgentTaskType;
  status: TaskStatus;
  priority: number;
  payload: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export type AgentTaskType =
  | 'repo_scrape'
  | 'sync_check'
  | 'health_check'
  | 'self_heal'
  | 'update_deploy'
  | 'media_process'
  | 'youtube_publish'
  | 'cleanup';

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled';

export interface RepoInfo {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  lastCommit: string;
  lastSyncedAt: string;
  structure: RepoStructure;
  dependencies: string[];
  interfaces: InterfaceDefinition[];
}

export interface RepoStructure {
  files: string[];
  directories: string[];
  configFiles: string[];
  entryPoints: string[];
}

export interface InterfaceDefinition {
  name: string;
  file: string;
  exports: string[];
  type: 'api' | 'event' | 'shared' | 'internal';
}

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: HealthCheck[];
  agents: AgentHealth[];
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  latencyMs?: number;
}

export interface AgentHealth {
  name: string;
  status: 'active' | 'idle' | 'error' | 'recovering';
  lastActivity: string;
  taskCount: number;
  errorCount: number;
}

export interface SelfHealAction {
  id: string;
  trigger: string;
  action: 'restart' | 'retry' | 'rollback' | 'alert' | 'scale';
  target: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  executedAt?: string;
  result?: string;
}

export interface SyncEvent {
  id: string;
  repo: string;
  type: 'push' | 'pr' | 'release' | 'workflow';
  ref?: string;
  commit?: string;
  payload: Record<string, unknown>;
  processedAt?: string;
}
