-- ⬛⬜🛣️ BlackRoad YouTube Workers - D1 Database Schema

-- Agent Tasks Table
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 5,
    payload TEXT DEFAULT '{}',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    result TEXT,

    -- Indexes for common queries
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'retrying', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON agent_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON agent_tasks(type);

-- Agent Reports Table
CREATE TABLE IF NOT EXISTS agent_reports (
    id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    agents TEXT NOT NULL,
    tasks TEXT NOT NULL,
    environment TEXT NOT NULL,

    CHECK (environment IN ('development', 'staging', 'production'))
);

CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON agent_reports(generated_at);

-- Sync Events Table
CREATE TABLE IF NOT EXISTS sync_events (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    event_type TEXT NOT NULL,
    ref TEXT,
    commit_sha TEXT,
    payload TEXT DEFAULT '{}',
    processed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_repo ON sync_events(repo);
CREATE INDEX IF NOT EXISTS idx_sync_created_at ON sync_events(created_at);

-- Self-Heal Actions Table
CREATE TABLE IF NOT EXISTS heal_actions (
    id TEXT PRIMARY KEY,
    trigger_reason TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    executed_at TEXT,
    result TEXT,

    CHECK (action_type IN ('restart', 'retry', 'rollback', 'alert', 'scale')),
    CHECK (status IN ('pending', 'executing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_heal_status ON heal_actions(status);
CREATE INDEX IF NOT EXISTS idx_heal_created_at ON heal_actions(created_at);

-- Repository Cache Table
CREATE TABLE IF NOT EXISTS repo_cache (
    repo_name TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    last_commit TEXT,
    structure TEXT DEFAULT '{}',
    interfaces TEXT DEFAULT '[]',
    dependencies TEXT DEFAULT '[]',
    synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repo_synced_at ON repo_cache(synced_at);

-- Cohesion Analysis Table
CREATE TABLE IF NOT EXISTS cohesion_analysis (
    id TEXT PRIMARY KEY,
    cohesion_score INTEGER NOT NULL,
    findings TEXT DEFAULT '[]',
    recommendations TEXT DEFAULT '[]',
    shared_dependencies TEXT DEFAULT '{}',
    analyzed_at TEXT NOT NULL,
    triggered_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_cohesion_analyzed_at ON cohesion_analysis(analyzed_at);
