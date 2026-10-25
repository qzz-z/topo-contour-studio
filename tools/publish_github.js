'use strict';
/**
 * Publish this project through the GitHub REST API (no git binary required).
 *
 * Required environment:
 *   GH_TOKEN   fine-grained PAT or classic PAT
 *   GH_OWNER   GitHub user or org (optional; defaults to authenticated user)
 *   GH_REPO    repository name (default: topo-contour-studio)
 *   GH_PRIVATE "true" for private (default public)
 *
 * The token needs: Administration write (to create the repo), Contents write,
 * Workflows write (for .github/workflows), Releases write.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com';
let TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  const tokenFile = path.join(process.cwd(), '.gh-token');
  if (fs.existsSync(tokenFile)) TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
}
const REPO = process.env.GH_REPO || 'topo-contour-studio';
const PRIVATE = String(process.env.GH_PRIVATE || 'false').toLowerCase() === 'true';
const VERSION = require('../package.json').version;
const TAG = `v${VERSION}`;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN。请先设置 GitHub Personal Access Token。');
  process.exit(1);
}

async function gh(endpoint, options = {}) {
  const res = await fetch(API + endpoint, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'topo-contour-studio-publisher',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = data && data.message ? data.message : String(data || res.statusText);
    const err = new Error(`${options.method || 'GET'} ${endpoint} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function collectFiles() {
  const files = [];
  const add = rel => {
    const p = path.join(process.cwd(), rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push(rel.replace(/\\/g, '/'));
  };
  for (const f of ['.gitignore', 'LICENSE.md', 'README.md', 'package.json', 'package-lock.json',
    'electron-main.js', 'server.js', 'generate.js', '启动生成器.bat']) add(f);
  const walk = (rel, filter) => {
    const dir = path.join(process.cwd(), rel);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(r, filter);
      else if (!filter || filter(r)) add(r);
    }
  };
  walk('.github');
  walk('src');
  walk('web');
  walk('data', f => !/\.hgt(\.gz)?$/i.test(f));
  walk('tools');
  for (const f of ['build/icon.ico', 'build/icon-256.png']) add(f);
  walk('docs');
  const seen = new Set();
  return files.filter(f => !seen.has(f) && seen.add(f));
}

async function ensureRepo(owner) {
  try {
    return await gh(`/repos/${owner}/${REPO}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  console.log(`[repo] creating ${owner}/${REPO} (${PRIVATE ? 'private' : 'public'})`);
  return gh('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      private: PRIVATE,
      description: 'Topo Contour Studio — A3 elevation contour poster generator with real SRTM DEMs, random mountain scenes, SVG/PNG/PDF output and Windows GUI.',
      auto_init: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false
    })
  });
}

async function getHead(owner) {
  try {
    const ref = await gh(`/repos/${owner}/${REPO}/git/ref/heads/main`);
    return ref.object.sha;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function commitFiles(owner) {
  const files = collectFiles();
  console.log(`[files] ${files.length} files`);
  const tree = [];
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    const buf = fs.readFileSync(rel);
    const binary = /\.(png|jpg|jpeg|gif|webp|ico|gz|pdf|exe|zip)$/i.test(rel);
    process.stdout.write(`\r[blob] ${i + 1}/${files.length} ${rel.slice(-55).padEnd(55)}`);
    const blob = await gh(`/repos/${owner}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify(binary
        ? { content: buf.toString('base64'), encoding: 'base64' }
        : { content: buf.toString('utf8'), encoding: 'utf-8' })
    });
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  process.stdout.write('\n');

  const parent = await getHead(owner);
  const baseTree = parent
    ? (await gh(`/repos/${owner}/${REPO}/git/commits/${parent}`)).tree.sha
    : undefined;
  const newTree = await gh(`/repos/${owner}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree, ...(baseTree ? { base_tree: baseTree } : {}) })
  });
  const commit = await gh(`/repos/${owner}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `Release ${TAG}: 8 real mountain scenes + random generation`,
      tree: newTree.sha,
      parents: parent ? [parent] : []
    })
  });
  if (parent) {
    await gh(`/repos/${owner}/${REPO}/git/refs/heads/main`, {
      method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true })
    });
  } else {
    await gh(`/repos/${owner}/${REPO}/git/refs`, {
      method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha })
    });
  }
  console.log(`[commit] ${commit.sha}`);
  return commit.sha;
}

async function createRelease(owner, sha) {
  try {
    const existing = await gh(`/repos/${owner}/${REPO}/releases/tags/${TAG}`);
    console.log(`[release] ${TAG} already exists: ${existing.html_url}`);
    return existing;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const release = await gh(`/repos/${owner}/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: sha,
      name: `Topo Contour Studio ${TAG}`,
      body: [
        '## Topo Contour Studio ' + TAG,
        '',
        '- 8 real SRTM mountain presets (Gongga, Matterhorn, Yulong, Fuji, Mont Blanc, Grossglockner, Meili, Namcha Barwa)',
        '- Random generation: random real mountain + constrained layout parameters',
        '- A3 300 dpi PNG, vector PDF, SVG, transparent contour art',
        '- Windows GUI installer built by the `Windows build` workflow',
        '',
        'The installer asset is attached automatically when the Windows build workflow finishes.'
      ].join('\n'),
      draft: false,
      prerelease: false
    })
  });
  console.log(`[release] ${release.html_url}`);
  return release;
}

async function uploadInstaller(owner, release) {
  const file = path.join('release', `TopoContourStudio-Setup-${VERSION}.exe`);
  if (!fs.existsSync(file)) {
    console.log('[asset] installer not found locally, skipped');
    return;
  }
  const stat = fs.statSync(file);
  console.log(`[asset] uploading ${file} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  try {
    const res = await fetch(`https://uploads.github.com/repos/${owner}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(file))}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        'User-Agent': 'topo-contour-studio-publisher'
      },
      body: fs.readFileSync(file),
      duplex: 'half'
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    console.log('[asset] uploaded');
  } catch (err) {
    console.warn('[asset] upload failed:', err.message);
    console.warn('[asset] GitHub Actions will build and attach the installer from the tag.');
  }
}

(async () => {
  const user = await gh('/user');
  const owner = process.env.GH_OWNER || user.login;
  console.log(`[auth] ${user.login} -> ${owner}/${REPO}`);
  await ensureRepo(owner);
  const sha = await commitFiles(owner);
  try {
    await gh(`/repos/${owner}/${REPO}/git/refs`, {
      method: 'POST', body: JSON.stringify({ ref: `refs/tags/${TAG}`, sha })
    });
    console.log(`[tag] ${TAG}`);
  } catch (err) {
    if (err.status !== 422) throw err;
    console.log(`[tag] ${TAG} already exists`);
  }
  const release = await createRelease(owner, sha);
  await uploadInstaller(owner, release);
  console.log(`\nhttps://github.com/${owner}/${REPO}`);
  console.log(`https://github.com/${owner}/${REPO}/releases/tag/${TAG}`);
})().catch(err => {
  console.error('\n[error]', err.message);
  if (err.data && err.data.documentation_url) console.error(err.data.documentation_url);
  process.exit(1);
});
