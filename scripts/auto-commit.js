const { spawnSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const shouldPush = args.has('--push') || process.env.AUTO_PUSH === '1';
const pollMs = Math.max(1000, Number.parseInt(process.env.AUTO_COMMIT_POLL_MS || '2500', 10) || 2500);
const debounceMs = Math.max(1000, Number.parseInt(process.env.AUTO_COMMIT_DEBOUNCE_MS || '4000', 10) || 4000);

function log(message) {
  console.log(`[auto-commit ${new Date().toISOString()}] ${message}`);
}

function runGit(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function getCurrentBranch() {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to determine current branch');
  }
  return result.stdout.trim();
}

function getStatusSignature() {
  const result = runGit(['status', '--porcelain', '--untracked-files=all']);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'git status failed');
  }
  return result.stdout.trim();
}

function commitChanges(statusSignature) {
  const addResult = runGit(['add', '-A']);
  if (addResult.status !== 0) {
    throw new Error(addResult.stderr.trim() || 'git add failed');
  }

  const latestSignature = getStatusSignature();
  if (!latestSignature) {
    return false;
  }

  const changedFileCount = statusSignature.split(/\r?\n/).filter(Boolean).length;
  const commitMessage = `auto: ${new Date().toISOString()} (${changedFileCount} files)`;
  const commitResult = runGit(['commit', '-m', commitMessage, '--no-verify']);
  const commitOutput = `${commitResult.stdout}\n${commitResult.stderr}`.trim();

  if (commitResult.status !== 0) {
    if (commitOutput.includes('nothing to commit')) {
      return false;
    }
    throw new Error(commitOutput || 'git commit failed');
  }

  log(`Committed ${changedFileCount} file(s): ${commitMessage}`);

  if (shouldPush) {
    const branch = getCurrentBranch();
    const pushResult = runGit(['push', 'origin', branch]);
    if (pushResult.status !== 0) {
      throw new Error(pushResult.stderr.trim() || 'git push failed');
    }
    log(`Pushed commit to origin/${branch}`);
  }

  return true;
}

let lastSignature = '';
let lastDirtyAt = 0;
let commitInProgress = false;

function pollRepo() {
  if (commitInProgress) {
    return;
  }

  try {
    const statusSignature = getStatusSignature();

    if (!statusSignature) {
      lastSignature = '';
      lastDirtyAt = 0;
      return;
    }

    if (statusSignature !== lastSignature) {
      lastSignature = statusSignature;
      lastDirtyAt = Date.now();
      log('Changes detected; waiting for them to settle.');
      return;
    }

    if (Date.now() - lastDirtyAt < debounceMs) {
      return;
    }

    commitInProgress = true;
    const committed = commitChanges(statusSignature);
    if (committed) {
      lastSignature = '';
      lastDirtyAt = 0;
    }
  } catch (error) {
    log(`Watcher error: ${error.message}`);
    lastDirtyAt = Date.now();
  } finally {
    commitInProgress = false;
  }
}

log(`Watching ${process.cwd()} every ${pollMs}ms${shouldPush ? ' with auto-push enabled' : ''}.`);
pollRepo();

const intervalId = setInterval(pollRepo, pollMs);

function shutdown(signal) {
  clearInterval(intervalId);
  log(`Stopped (${signal}).`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
