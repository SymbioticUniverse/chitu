#!/usr/bin/env node
/**
 * Git pre-commit guard — blocks commit when working-tree changes exceed
 * .git/horsewhip/allowlist.json (written when you whip-lock nodes on the timeline).
 * Keep path rules in sync with extension/src/boundaryGuard.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const ROOT_BUCKET = '__root__';

function normalizeRelPath(raw) {
  return String(raw || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function isGuardIgnoredPath(file) {
  const f = normalizeRelPath(file);
  return f.startsWith('.horsewhip/') || f.startsWith('.git/');
}

function isFolderAllowPath(p) {
  return p === ROOT_BUCKET || p.endsWith('/');
}

function pathIsUnderAllowlist(file, allowlist) {
  const f = normalizeRelPath(file);
  if (!f) return false;
  for (const raw of allowlist) {
    const a = normalizeRelPath(raw);
    if (!a) continue;
    if (isFolderAllowPath(a)) {
      if (a === ROOT_BUCKET) {
        if (!f.includes('/')) return true;
        continue;
      }
      const prefix = a.endsWith('/') ? a : `${a}/`;
      if (f === prefix.slice(0, -1) || f.startsWith(prefix)) return true;
      continue;
    }
    if (f === a) return true;
  }
  return false;
}

function normalizeBranch(b) {
  const s = String(b || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'main' || lower === 'master') return lower;
  return s;
}

function readAllowlistRecord() {
  const file = path.join(ROOT, '.git', 'horsewhip', 'allowlist.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = Array.isArray(data.allowed) ? data.allowed : [];
    const guardActive = Boolean(data.guardActive);
    const lockMode = data.lockMode === 'full' ? 'full' : 'pasture';
    const mode = data.mode === 'append-only' ? 'append-only' : 'pasture';
    const fullLike = lockMode === 'full' || mode === 'append-only';
    const locked = Boolean(data.locked) && (fullLike || allowed.length > 0);
    return {
      guardActive,
      armed: guardActive && locked,
      allowed,
      lockMode,
      mode,
      targets: Array.isArray(data.targets) ? data.targets : [],
    };
  } catch {
    return null;
  }
}

function gitCurrentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function evaluateBranchLock(targets) {
  if (!targets.length) return null;
  const branches = [...new Set(targets.map((t) => normalizeBranch(t.branch)).filter(Boolean))];
  if (branches.length > 1) {
    return `瞄准了多条分支（${branches.join('、')}），请只瞄准同一分支。`;
  }
  const currentRaw = gitCurrentBranch();
  if (!currentRaw) {
    return '当前处于 detached HEAD，请先 git switch 到瞄准分支。';
  }
  const expected = branches[0] || '';
  const current = normalizeBranch(currentRaw);
  if (!expected) {
    if (current !== 'main' && current !== 'master') {
      return `瞄准为主泳道，但当前在 ⎇ ${currentRaw}。`;
    }
    return null;
  }
  if (current === expected) return null;
  if ((expected === 'main' || expected === 'master') && (current === 'main' || current === 'master')) {
    return null;
  }
  return `当前在 ⎇ ${currentRaw}，瞄准为 ⎇ ${expected}。请先 git switch ${expected}。`;
}

function gitIsTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

function computeOverreach(rec, actual) {
  if (rec.lockMode === 'full' || rec.mode === 'append-only') {
    return actual.filter((f) => {
      if (pathIsUnderAllowlist(f, rec.allowed)) return false;
      if (!gitIsTracked(f)) return false;
      return true;
    });
  }
  return actual.filter((f) => !pathIsUnderAllowlist(f, rec.allowed));
}

function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function changedFiles() {
  const files = new Set();
  const diff = gitLines(['diff', 'HEAD', '--name-only', '--diff-filter=ACDMRTUXB']);
  diff.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
  untracked.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
  if (!files.size) {
    const status = gitLines(['status', '--porcelain']);
    for (const line of status.split('\n')) {
      if (!line || line.length < 4) continue;
      let p = line.slice(3).trim().replace(/^"|"$/g, '');
      if (p.includes(' -> ')) p = p.split(' -> ').pop().trim();
      if (p) files.add(p);
    }
  }
  return [...files].filter((f) => !isGuardIgnoredPath(f)).sort();
}

function commitBlockedPath() {
  return path.join(ROOT, '.git', 'horsewhip', 'commit-blocked.json');
}

function clearCommitBlockedMarker() {
  try {
    fs.unlinkSync(commitBlockedPath());
  } catch {
    /* absent */
  }
}

function writeCommitBlockedMarker(allowed, overreach) {
  const dir = path.dirname(commitBlockedPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    commitBlockedPath(),
    `${JSON.stringify(
      {
        version: 1,
        at: new Date().toISOString(),
        source: 'pre-commit',
        allowed,
        overreach,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function main() {
  const rec = readAllowlistRecord();
  const actualEarly = changedFiles();
  if (!rec || !rec.guardActive) {
    clearCommitBlockedMarker();
    process.exit(0);
  }
  if (!rec.armed) {
    clearCommitBlockedMarker();
    process.exit(0);
  }
  const branchErr = evaluateBranchLock(rec.targets);
  if (branchErr) {
    console.error('');
    console.error('【horsewhip · commit 已拦截】');
    console.error(branchErr);
    console.error('');
    process.exit(1);
  }
  const allowed = rec.allowed;
  const actual = changedFiles();
  const overreach = computeOverreach(rec, actual);
  if (!overreach.length) {
    clearCommitBlockedMarker();
    process.exit(0);
  }
  writeCommitBlockedMarker(allowed, overreach);
  const allowText =
    rec.lockMode === 'full' || rec.mode === 'append-only'
      ? allowed.length
        ? `已解锁老文件：${allowed.join(', ')}`
        : '解耦架构：全部已跟踪文件只读（仅允许新建）'
      : allowed.join(', ');
  const overText = overreach.join(', ');
  console.error('');
  console.error('【horsewhip · commit 已拦截】');
  console.error(`挥鞭圈定（仅此可改）：${allowText}`);
  console.error(`圈外改动（禁止）：${overText}`);
  console.error('');
  console.error('越界文件仍留在工作区 — 请先 git checkout HEAD -- <越界路径> 复原，再在边界内重想方案。');
  console.error('horsewhip：检查越界 → 还原越界文件 / 插入纠正到 Chat；勿保留越界改动后误提交。');
  console.error('临时跳过：git commit --no-verify（不推荐，需用户明确同意）');
  console.error('');
  process.exit(1);
}

main();
