#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';

const [wasmArgument, libArgument, ...extraArgs] = process.argv.slice(2);
if (!wasmArgument || !libArgument || extraArgs.length !== 0) {
  console.error('Usage: node tests/smoke.mjs <zig.wasm> <zig-lib-directory>');
  process.exit(2);
}

const wasmPath = realpathSync(wasmArgument);
const libPath = realpathSync(libArgument);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const runner = join(testDirectory, '../scripts/run-wasi.mjs');
const project = mkdtempSync(join(tmpdir(), 'zigc-wasm-smoke-'));
const backendFlags = ['-fno-llvm', '-fno-lld', '-O', 'fast'];
const freestandingFlags = [
  ...backendFlags,
  '-target',
  'wasm32-freestanding',
  '-fno-entry',
  '-rdynamic',
];

function runCompiler(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [runner, wasmPath, libPath, ...args], {
    cwd: project,
    env: {
      ...process.env,
      ZIG_WASI_CACHE_DIR: join(project, '.zig-cache/global'),
      // Host Zig configuration must not override the guest's preopened dirs.
      ZIG_LIB_DIR: join(project, 'host-lib-must-not-leak'),
      ZIG_GLOBAL_CACHE_DIR: join(project, 'host-global-cache-must-not-leak'),
      ZIG_LOCAL_CACHE_DIR: join(project, 'host-local-cache-must-not-leak'),
      ZIG_LIBC: join(project, 'host-libc-must-not-leak.txt'),
    },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `zig ${args.join(' ')} was killed`);
  assert.equal(
    result.status,
    expectedStatus,
    `zig ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

async function checkArithmetic(filename) {
  const { instance } = await WebAssembly.instantiate(readFileSync(join(project, filename)));
  assert.equal(instance.exports.add(19, 23), 42);
  assert.equal(instance.exports.add(-12, 5), -7);
  assert.equal(instance.exports.sum_to(100), 5050);
  assert.equal(instance.exports.rotate(0x80000001), 48);
  assert.equal(instance.exports.divide_wide(1n, 0n, 3n), 6148914691236517205n);
  assert.equal(instance.exports.divide_wide(0n, 42n, 6n), 7n);
}

async function runWasi(filename, preopens = {}) {
  const stdoutPath = join(project, `${filename}.stdout`);
  const stdout = openSync(stdoutPath, 'w');
  try {
    const wasi = new WASI({
      version: 'preview1',
      args: [filename],
      env: {},
      preopens,
      stdout,
      returnOnExit: true,
    });
    const { instance } = await WebAssembly.instantiate(
      readFileSync(join(project, filename)),
      wasi.getImportObject(),
    );
    assert.equal(wasi.start(instance), 0, `WASI program ${filename} failed`);
  } finally {
    closeSync(stdout);
  }
  return readFileSync(stdoutPath, 'utf8');
}

try {
  for (const name of ['arithmetic.zig', 'invalid.zig', 'hello-wasi.zig', 'wasi-io.zig']) {
    copyFileSync(join(testDirectory, 'fixtures', name), join(project, name));
  }

  assert.equal(runCompiler(['version']).stdout.trim(), '0.17.0');
  console.log('ok: compiler reports Zig 0.17.0');

  const help = runCompiler(['help']).stdout;
  assert.match(help, /WASI compiler commands:/);
  assert.doesNotMatch(help, /Build project from build\.zig/);
  assert.doesNotMatch(help, /build-lib/);
  const environment = runCompiler(['env']).stdout;
  assert.match(environment, /\.lib_dir\s*=\s*"\/lib"/);
  assert.match(environment, /\.global_cache_dir\s*=\s*"\/cache"/);
  assert.match(environment, /\.version\s*=\s*"0\.17\.0"/);
  assert.match(environment, /\.ZIG_LIB_DIR\s*=\s*null/);
  assert.match(environment, /\.ZIG_GLOBAL_CACHE_DIR\s*=\s*null/);
  assert.match(environment, /\.ZIG_LOCAL_CACHE_DIR\s*=\s*"\.zig-cache\/local"/);
  assert.match(environment, /\.ZIG_LIBC\s*=\s*null/);
  const targets = runCompiler(['targets']).stdout;
  assert.match(targets, /\.wasm32\s*=\s*\.\{/);
  assert.match(targets, /\.triple\s*=\s*"wasm32-wasi/);
  runCompiler(['ast-check', 'arithmetic.zig']);
  runCompiler(['fmt', '--check', 'arithmetic.zig', 'invalid.zig', 'hello-wasi.zig', 'wasi-io.zig']);
  const unformattedPath = join(project, 'format-me.zig');
  writeFileSync(unformattedPath, 'export fn twice(value:u32)u32{return value*2;}\n');
  assert.equal(runCompiler(['fmt', 'format-me.zig']).stdout.trim(), 'format-me.zig');
  assert.equal(
    readFileSync(unformattedPath, 'utf8'),
    'export fn twice(value: u32) u32 {\n    return value * 2;\n}\n',
  );
  console.log('ok: WASI help, environment, targets, syntax checking, and formatting');

  for (const { args, diagnostic } of [
    { args: ['build'], diagnostic: /unavailable in the WASI compiler/ },
    { args: ['build-lib'], diagnostic: /unavailable in the WASI compiler/ },
    {
      args: ['build-exe', 'arithmetic.zig', ...freestandingFlags, '-fincremental'],
      diagnostic: /does not support feature incremental/,
    },
    {
      args: [
        'build-exe',
        'arithmetic.zig',
        ...backendFlags,
        '-target',
        'x86_64-linux',
        '-fno-entry',
      ],
      diagnostic: /does not support feature/,
    },
  ]) {
    const unsupported = runCompiler(args, 1);
    assert.match(unsupported.stderr, diagnostic);
    assert.doesNotMatch(unsupported.stderr, /RuntimeError|wasm trap|unreachable/i);
  }
  console.log('ok: unsupported commands, incremental compilation, and native targets fail cleanly');

  runCompiler(['build-exe', 'arithmetic.zig', ...freestandingFlags, '-femit-bin=arithmetic.wasm']);
  await checkArithmetic('arithmetic.wasm');
  console.log('ok: compile and execute freestanding arithmetic using std');

  runCompiler(['build-obj', 'arithmetic.zig', ...freestandingFlags, '-femit-bin=arithmetic.o']);
  runCompiler(['build-exe', 'arithmetic.o', ...freestandingFlags, '-femit-bin=relinked.wasm']);
  await checkArithmetic('relinked.wasm');
  console.log('ok: emit a relocatable object, relink it, and execute its exports');

  // Relocatable target metadata is required even without debug information
  // and when the MVP CPU has no enabled optional features to list.
  runCompiler([
    'build-obj',
    'arithmetic.zig',
    '-fno-llvm',
    '-fno-lld',
    '-O',
    'small',
    '-target',
    'wasm32-freestanding',
    '-mcpu=mvp',
    '-fstrip',
    '-femit-bin=stripped-mvp.o',
  ]);
  runCompiler([
    'build-exe',
    'stripped-mvp.o',
    ...freestandingFlags,
    '-mcpu=mvp',
    '-femit-bin=stripped-mvp.wasm',
  ]);
  await checkArithmetic('stripped-mvp.wasm');
  console.log('ok: a stripped MVP object relinks and executes its exports');

  const invalid = runCompiler(
    ['build-exe', 'invalid.zig', ...freestandingFlags, '--color', 'off', '-femit-bin=invalid.wasm'],
    1,
  );
  assert.match(invalid.stderr, /invalid\.zig:\d+:\d+: error:/);
  assert.match(invalid.stderr, /expected type 'u32'/);
  console.log('ok: invalid source produces a diagnostic and nonzero exit status');

  runCompiler([
    'build-exe',
    'hello-wasi.zig',
    ...backendFlags,
    '-target',
    'wasm32-wasi',
    '-femit-bin=hello-wasi.wasm',
  ]);
  assert.equal(await runWasi('hello-wasi.wasm'), 'zigc-wasm 0.17.0\n');
  console.log('ok: compile and execute a WASI program with stdout');

  mkdirSync(join(project, 'source/nested'), { recursive: true });
  writeFileSync(join(project, 'source/nested/input.txt'), 'read nested input\n');
  runCompiler([
    'build-exe',
    'wasi-io.zig',
    ...backendFlags,
    '-target',
    'wasm32-wasi',
    '-femit-bin=wasi-io.wasm',
  ]);
  assert.equal(
    await runWasi('wasi-io.wasm', { '.': project }),
    'PASS: nested read, nested create, positional read/write, inherited rights, restricted rights\n',
  );
  assert.equal(readFileSync(join(project, 'cache/a/b/manifest'), 'utf8'), 'write nested cache\n');
  console.log('ok: nested WASI directory and file access preserves capability rights');
} finally {
  rmSync(project, { recursive: true, force: true });
}
