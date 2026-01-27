#!/usr/bin/env node
// ⬛⬜🛣️ BlackRoad Repo Sync Script
// Manually trigger repo sync from command line

const WORKER_URL = process.env.WORKER_URL || 'https://youtube-blackroad.workers.dev';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  console.log('⬛⬜🛣️ BlackRoad Repo Sync');
  console.log('========================\n');

  switch (command) {
    case 'status':
      await checkStatus();
      break;

    case 'sync':
      const repo = args[1];
      await triggerSync(repo);
      break;

    case 'scrape':
      const scrapeRepo = args[1];
      await scrapeRepo(scrapeRepo);
      break;

    case 'health':
      await checkHealth();
      break;

    case 'agents':
      await listAgents();
      break;

    case 'cohesion':
      await analyzeCohesion();
      break;

    default:
      printHelp();
  }
}

async function checkStatus() {
  console.log('Checking sync status...\n');

  try {
    const response = await fetch(`${WORKER_URL}/api/sync/status`);
    const data = await response.json();

    console.log('Auto-sync enabled:', data.autoSyncEnabled);
    console.log('Last full sync:', data.lastFullSync || 'Never');
    console.log('Watched repos:', data.watchedRepos?.join(', '));
    console.log('\nWatched branches:');
    Object.entries(data.watchedBranches || {}).forEach(([repo, commit]) => {
      console.log(`  ${repo}: ${commit?.slice(0, 7) || 'unknown'}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function triggerSync(repo) {
  console.log(`Triggering sync${repo ? ` for ${repo}` : ' (full)'}...\n`);

  try {
    const body = repo ? { repo } : { full: true };
    const response = await fetch(`${WORKER_URL}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    console.log('Sync result:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function scrapeRepo(repo) {
  if (!repo) {
    console.error('Please specify a repo to scrape');
    return;
  }

  console.log(`Scraping ${repo}...\n`);

  try {
    const response = await fetch(`${WORKER_URL}/api/repos/${repo}/scrape`, {
      method: 'POST',
    });
    const data = await response.json();

    console.log('Scrape result:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function checkHealth() {
  console.log('Checking system health...\n');

  try {
    const response = await fetch(`${WORKER_URL}/api/health`);
    const data = await response.json();

    console.log('Overall:', data.overall);
    console.log('Timestamp:', data.timestamp);

    console.log('\nChecks:');
    data.checks?.forEach((check) => {
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
      console.log(`  ${icon} ${check.name}: ${check.status}${check.message ? ` - ${check.message}` : ''}`);
    });

    console.log('\nAgents:');
    data.agents?.forEach((agent) => {
      console.log(`  ${agent.name}: ${agent.status} (tasks: ${agent.taskCount}, errors: ${agent.errorCount})`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function listAgents() {
  console.log('Listing agents...\n');

  try {
    const response = await fetch(`${WORKER_URL}/api/agents`);
    const data = await response.json();

    console.log(`Coordinator started: ${data.coordinatorStarted}`);
    console.log(`Last health check: ${data.lastHealthCheck}`);
    console.log(`\nAgents (${data.count}):`);

    data.agents?.forEach((agent) => {
      console.log(`\n  ${agent.name}:`);
      console.log(`    Status: ${agent.status}`);
      console.log(`    Last activity: ${agent.lastActivity}`);
      console.log(`    Tasks: ${agent.taskCount}`);
      console.log(`    Errors: ${agent.errorCount}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

async function analyzeCohesion() {
  console.log('Analyzing cross-repo cohesion...\n');

  try {
    // First get all repos
    const reposResponse = await fetch(`${WORKER_URL}/api/repos`);
    const reposData = await reposResponse.json();

    console.log('Tracked repos:');
    reposData.repos?.forEach((repo) => {
      console.log(`  ${repo.name}: ${repo.data?.structure?.files?.length || 0} files, ${repo.data?.interfaces?.length || 0} interfaces`);
    });

    // Get interfaces
    const interfacesResponse = await fetch(`${WORKER_URL}/api/repos/youtube/interfaces`);
    const interfaces = await interfacesResponse.json();

    console.log('\nShared interfaces:', JSON.stringify(interfaces, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

function printHelp() {
  console.log(`
Usage: npm run sync:repos [command] [options]

Commands:
  status              Check sync status (default)
  sync [repo]         Trigger sync (optional: specific repo)
  scrape <repo>       Scrape a specific repository
  health              Check system health
  agents              List all agents
  cohesion            Analyze cross-repo cohesion

Environment:
  WORKER_URL          Worker URL (default: https://youtube-blackroad.workers.dev)

Examples:
  npm run sync:repos status
  npm run sync:repos sync
  npm run sync:repos sync blackroad-prism-console
  npm run sync:repos health
`);
}

main().catch(console.error);
