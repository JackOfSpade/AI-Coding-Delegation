#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', 'artifacts', 'coverage', 'node_modules']);
const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

export async function discoverSyntaxTargets(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);

  async function discover(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name) ? [] : discover(path);
        const extension = entry.name.slice(entry.name.lastIndexOf('.'));
        return entry.isFile() && JAVASCRIPT_EXTENSIONS.has(extension) ? [path] : [];
      }),
    );
    return nested.flat();
  }

  return (await discover(root)).sort();
}

function checkOneSyntaxTarget(target, stdio) {
  return new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, ['--check', target], {
      stdio,
      windowsHide: true,
    });
    child.once('error', rejectCheck);
    child.once('exit', (code) => {
      if (code === 0) resolveCheck();
      else rejectCheck(new Error(`syntax check failed for ${target}`));
    });
  });
}

export async function checkSyntaxTargets(targets, { concurrency = 8, stdio = 'inherit' } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < targets.length) {
      const target = targets[next];
      next += 1;
      try {
        await checkOneSyntaxTarget(target, stdio);
      } catch (error) {
        failure ||= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  if (failure) throw failure;
}

async function main() {
  const targets = await discoverSyntaxTargets();
  if (!targets.length) throw new Error('no JavaScript files found to syntax-check');
  await checkSyntaxTargets(targets);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
