// ⬛⬜🛣️ BlackRoad Sync Manager Agent
// Manages cross-repo synchronization and auto-updates

import { Env, SyncEvent, RepoInfo } from '../types/env';

interface SyncState {
  events: Map<string, SyncEvent>;
  syncHistory: SyncHistoryEntry[];
  lastFullSync: string;
  watchedBranches: Map<string, string>; // repo -> last commit
}

interface SyncHistoryEntry {
  id: string;
  repo: string;
  type: 'push' | 'pr' | 'release' | 'manual';
  success: boolean;
  timestamp: string;
  details?: string;
}

export class SyncManagerAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncState: SyncState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncState = {
      events: new Map(),
      syncHistory: [],
      lastFullSync: '',
      watchedBranches: new Map(),
    };

    // Load persisted state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SyncState>('syncState');
      if (stored) {
        this.syncState = {
          events: new Map(Object.entries(stored.events || {})),
          syncHistory: stored.syncHistory || [],
          lastFullSync: stored.lastFullSync || '',
          watchedBranches: new Map(Object.entries(stored.watchedBranches || {})),
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Handle GitHub webhook
      if (path === '/webhook' && request.method === 'POST') {
        const event = request.headers.get('x-github-event') || 'unknown';
        const body = await request.json();
        return this.handleWebhook(event, body);
      }

      // Manual sync trigger
      if (path === '/trigger' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return this.handleManualTrigger(body);
      }

      // Check for updates
      if (path === '/check' && request.method === 'GET') {
        return this.handleCheckUpdates();
      }

      // Get sync status
      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      // Get sync history
      if (path === '/history' && request.method === 'GET') {
        return this.handleHistory();
      }

      // Get pending events
      if (path === '/events' && request.method === 'GET') {
        return this.handleGetEvents();
      }

      // Process pending events
      if (path === '/process' && request.method === 'POST') {
        return this.handleProcessEvents();
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleWebhook(event: string, body: Record<string, unknown>): Promise<Response> {
    const syncEvent: SyncEvent = {
      id: crypto.randomUUID(),
      repo: (body.repository as { name?: string })?.name || 'unknown',
      type: this.mapEventType(event),
      payload: body,
    };

    // Extract relevant info based on event type
    if (event === 'push') {
      syncEvent.ref = body.ref as string;
      syncEvent.commit = (body.after as string) || (body.head_commit as { id?: string })?.id;
    } else if (event === 'pull_request') {
      const pr = body.pull_request as { head?: { sha?: string }; base?: { ref?: string } };
      syncEvent.ref = pr?.base?.ref;
      syncEvent.commit = pr?.head?.sha;
    }

    // Store event
    this.syncState.events.set(syncEvent.id, syncEvent);

    // Check if this affects our tracked repos
    const trackedRepos = this.env.TRACKED_REPOS.split(',').map(r => r.trim());
    const isTracked = trackedRepos.includes(syncEvent.repo);

    if (isTracked && this.env.AUTO_SYNC_ENABLED === 'true') {
      // Trigger auto-sync
      await this.processEvent(syncEvent);
    }

    await this.persistState();

    return new Response(JSON.stringify({
      received: true,
      eventId: syncEvent.id,
      repo: syncEvent.repo,
      autoSynced: isTracked && this.env.AUTO_SYNC_ENABLED === 'true',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private mapEventType(event: string): SyncEvent['type'] {
    switch (event) {
      case 'push':
        return 'push';
      case 'pull_request':
        return 'pr';
      case 'release':
        return 'release';
      case 'workflow_run':
      case 'workflow_dispatch':
        return 'workflow';
      default:
        return 'push';
    }
  }

  private async handleManualTrigger(body: { repo?: string; full?: boolean }): Promise<Response> {
    if (body.full) {
      // Full sync of all repos
      return this.handleFullSync();
    }

    if (body.repo) {
      // Sync specific repo
      return this.syncRepo(body.repo);
    }

    // Default: sync all tracked repos
    return this.handleFullSync();
  }

  private async handleFullSync(): Promise<Response> {
    const trackedRepos = this.env.TRACKED_REPOS.split(',').map(r => r.trim());
    const results: Record<string, unknown> = {};

    for (const repo of trackedRepos) {
      try {
        const result = await this.syncRepoInternal(repo);
        results[repo] = { success: true, ...result };

        this.syncState.syncHistory.push({
          id: crypto.randomUUID(),
          repo,
          type: 'manual',
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        results[repo] = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };

        this.syncState.syncHistory.push({
          id: crypto.randomUUID(),
          repo,
          type: 'manual',
          success: false,
          timestamp: new Date().toISOString(),
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.syncState.lastFullSync = new Date().toISOString();

    // Trim history to last 100 entries
    if (this.syncState.syncHistory.length > 100) {
      this.syncState.syncHistory = this.syncState.syncHistory.slice(-100);
    }

    await this.persistState();

    return new Response(JSON.stringify({
      fullSync: true,
      timestamp: this.syncState.lastFullSync,
      results,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async syncRepo(repo: string): Promise<Response> {
    try {
      const result = await this.syncRepoInternal(repo);

      this.syncState.syncHistory.push({
        id: crypto.randomUUID(),
        repo,
        type: 'manual',
        success: true,
        timestamp: new Date().toISOString(),
      });

      await this.persistState();

      return new Response(JSON.stringify({
        success: true,
        repo,
        ...result,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      this.syncState.syncHistory.push({
        id: crypto.randomUUID(),
        repo,
        type: 'manual',
        success: false,
        timestamp: new Date().toISOString(),
        details: error instanceof Error ? error.message : 'Unknown error',
      });

      await this.persistState();

      return new Response(JSON.stringify({
        success: false,
        repo,
        error: error instanceof Error ? error.message : 'Unknown error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async syncRepoInternal(repo: string): Promise<{ updated: boolean; commit?: string }> {
    // Trigger repo scraper to get latest data
    const scraperId = this.env.REPO_SCRAPER.idFromName(repo);
    const scraper = this.env.REPO_SCRAPER.get(scraperId);

    const scrapeResponse = await scraper.fetch(new Request('http://internal/scrape', {
      method: 'POST',
      body: JSON.stringify({ repo, org: this.env.BLACKROAD_ORG }),
    }));

    const scrapeResult = await scrapeResponse.json() as { success: boolean; repo?: RepoInfo };

    if (!scrapeResult.success || !scrapeResult.repo) {
      throw new Error('Scrape failed');
    }

    // Check if there's a new commit
    const previousCommit = this.syncState.watchedBranches.get(repo);
    const newCommit = scrapeResult.repo.lastCommit;

    if (previousCommit !== newCommit) {
      this.syncState.watchedBranches.set(repo, newCommit);

      // Check cohesion impact
      await this.analyzeCohesionImpact(repo);

      return { updated: true, commit: newCommit };
    }

    return { updated: false };
  }

  private async processEvent(event: SyncEvent): Promise<void> {
    event.processedAt = new Date().toISOString();

    try {
      // Sync the affected repo
      await this.syncRepoInternal(event.repo);

      // If it's a push to main, trigger cohesion analysis
      if (event.type === 'push' && event.ref?.includes('main')) {
        await this.analyzeCohesionImpact(event.repo);
      }

      // If it's a release, trigger update notification
      if (event.type === 'release') {
        await this.notifyRelease(event);
      }

      this.syncState.syncHistory.push({
        id: crypto.randomUUID(),
        repo: event.repo,
        type: event.type,
        success: true,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.syncState.syncHistory.push({
        id: crypto.randomUUID(),
        repo: event.repo,
        type: event.type,
        success: false,
        timestamp: new Date().toISOString(),
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async analyzeCohesionImpact(repo: string): Promise<void> {
    // Get cohesion analysis from repo scraper
    const scraperId = this.env.REPO_SCRAPER.idFromName('main');
    const scraper = this.env.REPO_SCRAPER.get(scraperId);

    const cohesionResponse = await scraper.fetch(new Request('http://internal/analyze-cohesion'));
    const cohesion = await cohesionResponse.json() as {
      cohesionScore: number;
      recommendations: string[];
    };

    // Store cohesion analysis
    await this.env.REPO_DATA.put(`cohesion:${repo}`, JSON.stringify({
      ...cohesion,
      analyzedAt: new Date().toISOString(),
      triggeredBy: repo,
    }));

    // If cohesion score drops significantly, trigger self-healing
    const previousCohesion = await this.env.REPO_DATA.get<{ cohesionScore: number }>(
      'cohesion:latest',
      'json'
    );

    if (previousCohesion && cohesion.cohesionScore < previousCohesion.cohesionScore - 10) {
      // Significant cohesion drop - alert
      const healerId = this.env.SELF_HEALER.idFromName('main');
      const healer = this.env.SELF_HEALER.get(healerId);

      await healer.fetch(new Request('http://internal/trigger', {
        method: 'POST',
        body: JSON.stringify({
          action: 'alert',
          target: 'cohesion',
          reason: `Cohesion score dropped from ${previousCohesion.cohesionScore} to ${cohesion.cohesionScore}`,
        }),
      }));
    }

    await this.env.REPO_DATA.put('cohesion:latest', JSON.stringify(cohesion));
  }

  private async notifyRelease(event: SyncEvent): Promise<void> {
    // Store release notification
    await this.env.AGENT_STATE.put(`release:${event.repo}:${event.id}`, JSON.stringify({
      repo: event.repo,
      event,
      notifiedAt: new Date().toISOString(),
    }), {
      expirationTtl: 604800, // 7 days
    });

    // Queue task to handle release updates
    await this.env.SYNC_QUEUE_PRODUCER.send({
      type: 'release_update',
      repo: event.repo,
      payload: event.payload,
    });
  }

  private async handleCheckUpdates(): Promise<Response> {
    const trackedRepos = this.env.TRACKED_REPOS.split(',').map(r => r.trim());
    const updates: Record<string, unknown> = {};

    for (const repo of trackedRepos) {
      try {
        // Check GitHub API for latest commit
        const headers: Record<string, string> = {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'BlackRoad-YouTube-Workers',
        };

        if (this.env.GITHUB_TOKEN) {
          headers['Authorization'] = `token ${this.env.GITHUB_TOKEN}`;
        }

        const response = await fetch(
          `https://api.github.com/repos/${this.env.BLACKROAD_ORG}/${repo}/commits?per_page=1`,
          { headers }
        );

        if (response.ok) {
          const commits = await response.json() as Array<{ sha: string; commit: { message: string } }>;
          const latestCommit = commits[0];
          const storedCommit = this.syncState.watchedBranches.get(repo);

          updates[repo] = {
            hasUpdate: latestCommit?.sha !== storedCommit,
            latestCommit: latestCommit?.sha,
            storedCommit,
            message: latestCommit?.commit?.message?.split('\n')[0],
          };
        } else {
          updates[repo] = {
            error: 'Failed to check updates',
            status: response.status,
          };
        }
      } catch (error) {
        updates[repo] = {
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    return new Response(JSON.stringify({
      checkedAt: new Date().toISOString(),
      updates,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleStatus(): Response {
    return new Response(JSON.stringify({
      autoSyncEnabled: this.env.AUTO_SYNC_ENABLED === 'true',
      lastFullSync: this.syncState.lastFullSync,
      watchedRepos: this.env.TRACKED_REPOS.split(',').map(r => r.trim()),
      watchedBranches: Object.fromEntries(this.syncState.watchedBranches),
      pendingEvents: this.syncState.events.size,
      historyCount: this.syncState.syncHistory.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleHistory(): Response {
    const history = this.syncState.syncHistory
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 50);

    return new Response(JSON.stringify({ history }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetEvents(): Response {
    const events = Array.from(this.syncState.events.values())
      .filter(e => !e.processedAt)
      .sort((a, b) => new Date(b.id).getTime() - new Date(a.id).getTime());

    return new Response(JSON.stringify({ events }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleProcessEvents(): Promise<Response> {
    const unprocessedEvents = Array.from(this.syncState.events.values())
      .filter(e => !e.processedAt);

    for (const event of unprocessedEvents) {
      await this.processEvent(event);
    }

    await this.persistState();

    return new Response(JSON.stringify({
      processed: unprocessedEvents.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('syncState', {
      events: Object.fromEntries(this.syncState.events),
      syncHistory: this.syncState.syncHistory,
      lastFullSync: this.syncState.lastFullSync,
      watchedBranches: Object.fromEntries(this.syncState.watchedBranches),
    });
  }

  // Periodic sync check via alarm
  async alarm(): Promise<void> {
    if (this.env.AUTO_SYNC_ENABLED === 'true') {
      await this.handleCheckUpdates();
    }

    // Schedule next check in 15 minutes
    await this.state.storage.setAlarm(Date.now() + 900000);
  }
}
