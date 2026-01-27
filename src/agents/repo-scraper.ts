// ⬛⬜🛣️ BlackRoad Repo Scraper Agent
// Scrapes and indexes BlackRoad organization repositories for cohesiveness

import { Env, RepoInfo, RepoStructure, InterfaceDefinition } from '../types/env';

interface ScraperState {
  repos: Map<string, RepoInfo>;
  lastScrape: string;
  scrapeCount: number;
}

export class RepoScraperAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private scraperState: ScraperState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.scraperState = {
      repos: new Map(),
      lastScrape: '',
      scrapeCount: 0,
    };

    // Load persisted state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ScraperState>('scraperState');
      if (stored) {
        this.scraperState = {
          repos: new Map(Object.entries(stored.repos || {})),
          lastScrape: stored.lastScrape || '',
          scrapeCount: stored.scrapeCount || 0,
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Scrape a repository
      if (path === '/scrape' && request.method === 'POST') {
        const body = await request.json();
        return this.handleScrape(body.repo, body.org);
      }

      // Scrape all tracked repos
      if (path === '/scrape-all' && request.method === 'POST') {
        return this.handleScrapeAll();
      }

      // Get repo data
      if (path === '/repos' && request.method === 'GET') {
        return this.handleGetRepos();
      }

      // Get specific repo
      const repoMatch = path.match(/^\/repo\/([^/]+)$/);
      if (repoMatch && request.method === 'GET') {
        return this.handleGetRepo(repoMatch[1]);
      }

      // Find shared interfaces
      if (path === '/interfaces' && request.method === 'GET') {
        return this.handleGetInterfaces();
      }

      // Analyze cohesiveness
      if (path === '/analyze-cohesion' && request.method === 'GET') {
        return this.handleAnalyzeCohesion();
      }

      // Trigger (for coordinator)
      if (path === '/trigger' && request.method === 'POST') {
        return this.handleScrapeAll();
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

  private async handleScrape(repo: string, org: string): Promise<Response> {
    const repoInfo = await this.scrapeRepository(repo, org);

    // Store in KV for quick access
    await this.env.REPO_DATA.put(`repo:${repo}`, JSON.stringify(repoInfo));
    await this.env.REPO_DATA.put(`interfaces:${repo}`, JSON.stringify(repoInfo.interfaces));

    // Store in local state
    this.scraperState.repos.set(repo, repoInfo);
    this.scraperState.lastScrape = new Date().toISOString();
    this.scraperState.scrapeCount++;

    await this.persistState();

    return new Response(JSON.stringify({
      success: true,
      repo: repoInfo,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async scrapeRepository(repo: string, org: string): Promise<RepoInfo> {
    const githubToken = this.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'BlackRoad-YouTube-Workers',
    };

    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    // Get repository info
    const repoResponse = await fetch(`https://api.github.com/repos/${org}/${repo}`, { headers });

    if (!repoResponse.ok) {
      // Return minimal info if API fails (rate limited, etc.)
      return this.createMinimalRepoInfo(repo, org);
    }

    const repoData = await repoResponse.json() as Record<string, unknown>;

    // Get repository tree
    const defaultBranch = (repoData.default_branch as string) || 'main';
    const treeResponse = await fetch(
      `https://api.github.com/repos/${org}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers }
    );

    let structure: RepoStructure = {
      files: [],
      directories: [],
      configFiles: [],
      entryPoints: [],
    };

    if (treeResponse.ok) {
      const treeData = await treeResponse.json() as { tree: Array<{ path: string; type: string }> };
      structure = this.analyzeTree(treeData.tree || []);
    }

    // Get latest commit
    const commitsResponse = await fetch(
      `https://api.github.com/repos/${org}/${repo}/commits?per_page=1`,
      { headers }
    );

    let lastCommit = '';
    if (commitsResponse.ok) {
      const commits = await commitsResponse.json() as Array<{ sha: string }>;
      lastCommit = commits[0]?.sha || '';
    }

    // Analyze interfaces and dependencies
    const interfaces = await this.analyzeInterfaces(org, repo, structure, headers);
    const dependencies = this.analyzeDependencies(structure);

    return {
      name: repo,
      fullName: `${org}/${repo}`,
      url: `https://github.com/${org}/${repo}`,
      defaultBranch,
      lastCommit,
      lastSyncedAt: new Date().toISOString(),
      structure,
      dependencies,
      interfaces,
    };
  }

  private createMinimalRepoInfo(repo: string, org: string): RepoInfo {
    return {
      name: repo,
      fullName: `${org}/${repo}`,
      url: `https://github.com/${org}/${repo}`,
      defaultBranch: 'main',
      lastCommit: '',
      lastSyncedAt: new Date().toISOString(),
      structure: {
        files: [],
        directories: [],
        configFiles: [],
        entryPoints: [],
      },
      dependencies: [],
      interfaces: [],
    };
  }

  private analyzeTree(tree: Array<{ path: string; type: string }>): RepoStructure {
    const files: string[] = [];
    const directories: string[] = [];
    const configFiles: string[] = [];
    const entryPoints: string[] = [];

    const configPatterns = [
      'package.json', 'tsconfig.json', 'wrangler.toml', '.env.example',
      'Cargo.toml', 'pyproject.toml', 'go.mod', 'Dockerfile',
    ];

    const entryPatterns = [
      'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
      'index.ts', 'index.js', 'main.ts', 'main.js', 'src/lib.rs',
    ];

    for (const item of tree) {
      if (item.type === 'blob') {
        files.push(item.path);

        if (configPatterns.some(p => item.path.endsWith(p))) {
          configFiles.push(item.path);
        }

        if (entryPatterns.some(p => item.path === p || item.path.endsWith('/' + p))) {
          entryPoints.push(item.path);
        }
      } else if (item.type === 'tree') {
        directories.push(item.path);
      }
    }

    return { files, directories, configFiles, entryPoints };
  }

  private async analyzeInterfaces(
    org: string,
    repo: string,
    structure: RepoStructure,
    headers: Record<string, string>
  ): Promise<InterfaceDefinition[]> {
    const interfaces: InterfaceDefinition[] = [];

    // Look for common interface patterns
    const interfaceFiles = structure.files.filter(f =>
      f.includes('types') ||
      f.includes('interfaces') ||
      f.includes('api') ||
      f.includes('shared') ||
      f.endsWith('.d.ts')
    );

    for (const file of interfaceFiles.slice(0, 10)) { // Limit to prevent rate limiting
      try {
        const contentResponse = await fetch(
          `https://api.github.com/repos/${org}/${repo}/contents/${file}`,
          { headers }
        );

        if (contentResponse.ok) {
          const contentData = await contentResponse.json() as { content?: string };
          if (contentData.content) {
            const content = atob(contentData.content);
            const exports = this.extractExports(content);

            if (exports.length > 0) {
              interfaces.push({
                name: file.split('/').pop() || file,
                file,
                exports,
                type: this.determineInterfaceType(file),
              });
            }
          }
        }
      } catch {
        // Skip files that fail
      }
    }

    return interfaces;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportRegex = /export\s+(?:interface|type|class|function|const|enum)\s+(\w+)/g;
    let match;

    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return exports;
  }

  private determineInterfaceType(file: string): InterfaceDefinition['type'] {
    if (file.includes('api') || file.includes('endpoint')) return 'api';
    if (file.includes('event')) return 'event';
    if (file.includes('shared') || file.includes('common')) return 'shared';
    return 'internal';
  }

  private analyzeDependencies(structure: RepoStructure): string[] {
    const deps: string[] = [];

    // Look for @blackroad-os dependencies in package.json patterns
    if (structure.configFiles.some(f => f.endsWith('package.json'))) {
      deps.push('npm'); // Indicates Node.js project
    }

    if (structure.configFiles.some(f => f.endsWith('wrangler.toml'))) {
      deps.push('cloudflare-workers');
    }

    if (structure.configFiles.some(f => f.endsWith('Cargo.toml'))) {
      deps.push('rust');
    }

    // Detect internal dependencies by directory patterns
    if (structure.directories.some(d => d.includes('agents'))) {
      deps.push('@blackroad-os/agents');
    }

    if (structure.directories.some(d => d.includes('prism'))) {
      deps.push('@blackroad-os/prism');
    }

    return deps;
  }

  private async handleScrapeAll(): Promise<Response> {
    const repos = this.env.TRACKED_REPOS.split(',').map(r => r.trim());
    const results: Record<string, unknown> = {};

    for (const repo of repos) {
      try {
        const repoInfo = await this.scrapeRepository(repo, this.env.BLACKROAD_ORG);
        await this.env.REPO_DATA.put(`repo:${repo}`, JSON.stringify(repoInfo));
        await this.env.REPO_DATA.put(`interfaces:${repo}`, JSON.stringify(repoInfo.interfaces));

        this.scraperState.repos.set(repo, repoInfo);
        results[repo] = { success: true, files: repoInfo.structure.files.length };
      } catch (error) {
        results[repo] = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    this.scraperState.lastScrape = new Date().toISOString();
    this.scraperState.scrapeCount++;
    await this.persistState();

    // Notify coordinator of completion
    await this.notifyCoordinator('idle');

    return new Response(JSON.stringify({
      scrapedAt: this.scraperState.lastScrape,
      results,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetRepos(): Response {
    const repos = Array.from(this.scraperState.repos.values()).map(r => ({
      name: r.name,
      fullName: r.fullName,
      lastSyncedAt: r.lastSyncedAt,
      fileCount: r.structure.files.length,
      interfaceCount: r.interfaces.length,
    }));

    return new Response(JSON.stringify({
      repos,
      lastScrape: this.scraperState.lastScrape,
      scrapeCount: this.scraperState.scrapeCount,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetRepo(name: string): Response {
    const repo = this.scraperState.repos.get(name);

    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repository not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(repo), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetInterfaces(): Response {
    const allInterfaces: Record<string, InterfaceDefinition[]> = {};
    const sharedExports: Map<string, string[]> = new Map();

    for (const [name, repo] of this.scraperState.repos) {
      allInterfaces[name] = repo.interfaces;

      // Track shared exports across repos
      for (const iface of repo.interfaces) {
        if (iface.type === 'shared' || iface.type === 'api') {
          for (const exp of iface.exports) {
            const existing = sharedExports.get(exp) || [];
            existing.push(name);
            sharedExports.set(exp, existing);
          }
        }
      }
    }

    // Find exports that appear in multiple repos
    const crossRepoInterfaces = Array.from(sharedExports.entries())
      .filter(([, repos]) => repos.length > 1)
      .map(([name, repos]) => ({ name, repos }));

    return new Response(JSON.stringify({
      byRepo: allInterfaces,
      crossRepo: crossRepoInterfaces,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleAnalyzeCohesion(): Response {
    const repos = Array.from(this.scraperState.repos.values());
    const analysis: Record<string, unknown> = {
      totalRepos: repos.length,
      cohesionScore: 0,
      findings: [],
      recommendations: [],
    };

    // Analyze shared patterns
    const sharedDependencies = new Map<string, number>();
    const techStacks = new Map<string, number>();

    for (const repo of repos) {
      for (const dep of repo.dependencies) {
        sharedDependencies.set(dep, (sharedDependencies.get(dep) || 0) + 1);
      }
    }

    // Calculate cohesion score based on shared dependencies
    const sharedDeps = Array.from(sharedDependencies.entries())
      .filter(([, count]) => count > 1);

    analysis.cohesionScore = repos.length > 0
      ? Math.round((sharedDeps.length / repos.length) * 100)
      : 0;

    // Generate findings
    const findings: string[] = [];

    if (sharedDependencies.get('cloudflare-workers')) {
      findings.push('Multiple repos use Cloudflare Workers - good for consistency');
    }

    if (sharedDependencies.get('@blackroad-os/agents')) {
      findings.push('Shared agent framework detected across repos');
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (sharedDeps.length < 2) {
      recommendations.push('Consider extracting shared interfaces to a common package');
    }

    if (!sharedDependencies.get('cloudflare-workers')) {
      recommendations.push('Standardize on Cloudflare Workers for edge computing');
    }

    analysis.findings = findings;
    analysis.recommendations = recommendations;
    analysis.sharedDependencies = Object.fromEntries(sharedDependencies);

    return new Response(JSON.stringify(analysis), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async notifyCoordinator(status: 'active' | 'idle' | 'error'): Promise<void> {
    const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
    const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('http://internal/status', {
      method: 'POST',
      body: JSON.stringify({ agent: 'repo-scraper', status }),
    }));
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('scraperState', {
      repos: Object.fromEntries(this.scraperState.repos),
      lastScrape: this.scraperState.lastScrape,
      scrapeCount: this.scraperState.scrapeCount,
    });
  }
}
