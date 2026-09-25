import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(repoRoot, 'app');
const sourceRoots = [appRoot, path.join(repoRoot, 'components')];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function routePattern(route) {
  const escaped = route
    .split('/')
    .map(segment => /^\[\.\.\..+\]$/.test(segment)
      ? '.+'
      : /^\[.+\]$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(`^${escaped}/?$`);
}

async function collectRoutes() {
  const files = (await walk(appRoot)).filter(file => /(?:page|route)\.(?:tsx|ts|jsx|js)$/.test(file));
  return files.map(file => {
    const relative = path.relative(appRoot, file).replaceAll(path.sep, '/');
    const route = relative
      .replace(/\/(?:page|route)\.(?:tsx|ts|jsx|js)$/, '')
      .replace(/^(?:page|route)\.(?:tsx|ts|jsx|js)$/, '');
    return route ? `/${route}` : '/';
  });
}

function extractLocalDestinations(source) {
  const destinations = [];
  const pattern = /\b(?:href|action)\s*(?:=|:)\s*["'](\/(?!\/)[^"']*)["']/g;
  for (const match of source.matchAll(pattern)) {
    const destination = match[1].split(/[?#]/, 1)[0] || '/';
    destinations.push(destination);
  }
  return destinations;
}

const routes = await collectRoutes();
const routeMatchers = routes.map(route => ({ route, matcher: routePattern(route) }));
const sourceFiles = (await Promise.all(sourceRoots.map(walk))).flat()
  .filter(file => /\.(?:tsx|ts|jsx|js)$/.test(file));
const sourceByFile = new Map(await Promise.all(sourceFiles.map(async file => [file, await readFile(file, 'utf8')])));

function matchesRoute(destination) {
  return routeMatchers.some(({ matcher }) => matcher.test(destination));
}

test('every literal internal href/action resolves to a Next page or API route', () => {
  const missing = [];
  for (const [file, source] of sourceByFile) {
    for (const destination of extractLocalDestinations(source)) {
      if (!matchesRoute(destination)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${destination}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Broken internal destinations:\n${missing.join('\n')}`);
});

test('class attendance links target the dynamic class attendance route', async () => {
  assert.ok(matchesRoute('/manual-attendance/test-class-id'));
  const source = await readFile(path.join(appRoot, 'dashboard/classes/CopyLinkButton.tsx'), 'utf8');
  assert.match(source, /\/manual-attendance\/\$\{classId\}/);
});

test('a non-cacheable health route exists for platform readiness probes', async () => {
  assert.ok(matchesRoute('/api/health'));
  const source = await readFile(path.join(appRoot, 'api/health/route.ts'), 'utf8');
  assert.match(source, /Cache-Control.*no-store/);
  assert.match(source, /status:\s*'unavailable'/);
});

test('the two attendance pages exist and the kiosk navigation points to the kiosk page', async () => {
  assert.ok(matchesRoute('/mark-attendance'));
  assert.ok(matchesRoute('/manual-attendance/test-class-id'));
  const sidebar = await readFile(path.join(appRoot, 'dashboard/Sidebar.tsx'), 'utf8');
  assert.match(sidebar, /href:\s*'\/mark-attendance'/);
});
