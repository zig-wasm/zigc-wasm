#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { WASI } from 'node:wasi';

const [wasmPath, libPath, ...args] = process.argv.slice(2);

if (!wasmPath || !libPath || args.length === 0) {
  console.error(
    'Usage: node scripts/run-wasi.mjs <zig.wasm> <zig-lib-directory> <command> [args...]',
  );
  process.exitCode = 2;
} else {
  try {
    const cwd = process.cwd();
    const cachePath = resolve(
      process.env.ZIG_WASI_CACHE_DIR ?? resolve(cwd, '.zig-cache/global'),
    );
    mkdirSync(cachePath, { recursive: true });

    const env = { ...process.env, ZIG_LOCAL_CACHE_DIR: '.zig-cache/local' };
    // Let Zig select the /lib and /cache preopened handles. Environment
    // overrides instead open those absolute paths relative to cwd, which WASI
    // rejects. Host installation/cache settings must not enter the guest.
    delete env.ZIG_LIB_DIR;
    delete env.ZIG_GLOBAL_CACHE_DIR;
    delete env.ZIG_LIBC;
    delete env.ZIG_WASI_CACHE_DIR;

    const wasi = new WASI({
      version: 'preview1',
      args: ['zig', ...args],
      env,
      preopens: {
        // Zig's WASI std.Io backend requires fd 3 to name the working directory.
        '.': cwd,
        '/lib': realpathSync(libPath),
        '/cache': realpathSync(cachePath),
      },
      returnOnExit: true,
    });
    const module = await WebAssembly.compile(readFileSync(resolve(wasmPath)));
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    process.exitCode = wasi.start(instance);
  } catch (error) {
    console.error(`run-wasi: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
