# Zig.wasm

Build Zig 0.17.0 as a wasm32-wasi (WASI Preview 1) compiler. The compiler
runs in a WASI host and generates WebAssembly with Zig's self-hosted backend.
It can also emit LLVM IR and bitcode with debug metadata using Zig's own IR
builder. No LLVM libraries, Clang, LLD, or native machine-code backends are
included in the WASI compiler.

The original zig/0.11.x.patch remains available for the older compiler.
zig/0.17.0.patch applies to the official 0.17.0 source release, not Zig master.

## Build

Requirements: Python 3.10+, Git, and Node.js 24 for the runner and tests.
Allow several GB of memory and disk space for the native cross-compilation.

    python3 scripts/build.py

The script downloads the official source and native compiler, checks their
pinned SHA-256 hashes, applies the patch, and builds with:

    zig build -Dtarget=wasm32-wasi -Ddev=wasm_wasi \
      -Denable-llvm=false -Dsingle-threaded=true -Doptimize=small \
      -Dstrip=true -Dno-lib=true -Dversion-string=0.17.0

Native compiler downloads support Linux x86_64 and aarch64. On other hosts,
provide an installed Zig 0.17.0 with --zig /path/to/zig. Only Linux x86_64
is covered by CI. The native cross-compiler uses LLVM internally; the emitted
WASI compiler contains only the self-hosted Wasm backend.

Outputs are dist/0.17.0/zig.wasm, the matching lib/ directory, Zig's LICENSE,
and build-info.json with source, patch, and binary hashes. Keep zig.wasm and
lib/ together when distributing the compiler. Build intermediates go in
.build/. --work-dir, --output, and --jobs override the defaults.

## Run

    node scripts/run-wasi.mjs dist/0.17.0/zig.wasm dist/0.17.0/lib version

For a source file in the current directory:

    node scripts/run-wasi.mjs dist/0.17.0/zig.wasm dist/0.17.0/lib \
      build-exe example.zig -target wasm32-freestanding \
      -fno-llvm -fno-lld -fno-entry -rdynamic -O fast \
      -femit-bin=example.wasm

Use relative source and output paths inside the current directory. When
running from a different project, pass absolute host paths to the runner,
zig.wasm, and lib/. The runner forwards the compiler's exit status.

The WASI host must preopen these guest directories:

  .       Working directory, FIRST preopen (file descriptor 3).
  /lib    Matching Zig 0.17.0 lib/ directory.
  /cache  Writable compiler cache directory.

The Node runner configures these handles and strips host-side ZIG_LIB_DIR,
ZIG_GLOBAL_CACHE_DIR, and ZIG_LIBC overrides. Its global cache defaults to
.zig-cache/global; set ZIG_WASI_CACHE_DIR to choose another host directory.
The local cache is .zig-cache/local. Serialize invocations that share either
cache; WASI does not provide the file locks used by the native compiler.

Supported commands: build-exe, build-obj, ast-check, fmt, targets,
version, env, and help. For direct WebAssembly output, select a WebAssembly
target and use -fno-llvm -fno-lld. The targets command describes Zig's target database;
it does not mean this reduced compiler includes every backend.

zig build, build-lib, run, test, cc, C/C++ compilation, package fetching, native output,
compiler-server protocols, and incremental compilation are not supported.
Compile a WASI executable with build-exe and execute it separately in a WASI
host. The self-hosted Wasm backend has upstream limitations; this is not a
replacement for the full native Zig distribution. In particular, build-lib
is disabled because the upstream self-hosted Wasm linker does not emit
static archives; build-obj produces relocatable objects for later linking.

## LLVM IR and source debugging

The WASI compiler can emit unoptimized LLVM IR and bitcode without libLLVM.
Use the public output options with -fllvm -fno-libllvm -fno-lld -fno-emit-bin:

    node scripts/run-wasi.mjs dist/0.17.0/zig.wasm dist/0.17.0/lib \
      build-exe main.zig -target wasm32-wasi -mcpu=mvp -O debug \
      -fllvm -fno-libllvm -fno-lld -fno-emit-bin -fno-compiler-rt \
      -femit-llvm-bc=main.bc -femit-llvm-ir=main.ll

Either output option can be used independently. This path keeps Zig's original
source, function, local-variable, and type metadata. Relative source filenames
retain all path components and use '.' as their debug directory, relative to
the working directory preopened as fd 3. The compilation unit uses the same
base, so nested source directories are not counted twice. Known library roots retain /lib.
No absolute host directory or browser-specific source root is assumed; configure
the external debugger's source mapping for the guest paths used by your host.

The final machine-code build and link belong to an external LLVM toolchain.
For a WASI program, provide the matching compiler_rt implementation and the
required WASI runtime libraries. Emit compiler_rt as bitcode with the same
options, using build-obj /lib/compiler_rt.zig instead of build-exe main.zig.
Zig supplies the program entry point, so do not add a C startup object.
Retain debug information during code generation and linking to produce DWARF
sections that an external debugger such as LLDB can read.

This compiler does not include LLDB, WAMR, an LLVM optimizer, or an LLVM
machine-code generator. Requesting LLVM machine-code output without libLLVM
still fails with a diagnostic. Normal self-hosted Wasm output remains available.

## Verify

    node tests/smoke.mjs dist/0.17.0/zig.wasm dist/0.17.0/lib

The smoke test invokes the WASI compiler, checks its version, compiles a
program importing std, executes its exported functions (including u128
division through compiler_rt), emits and relinks ordinary and stripped MVP
objects, checks invalid-source diagnostics and exit status,
and compiles and executes a WASI program that writes to stdout.
It also checks help, formatting, environment isolation, unsupported commands,
and a WASI program exercising nested filesystem access and capability rights.
It also emits real LLVM IR and bitcode, checks nested and single-component
relative source paths, /lib paths, local-variable/type metadata, and matching
compiler_rt output. Invalid IR input and unsupported LLVM machine-code output
must fail cleanly. These tests check compiler output, not an external debugger.

GitHub Actions builds from the pinned archives, runs this test, and uploads
the resulting compiler bundle as zigc-wasm-0.17.0.

## Patch design

Zig 0.17 already implements WASI filesystem I/O, preopened directories,
the wasm allocator, and a buffered alternative to memory mapping. The old
0.11 realpath and unconditional linker-dispatch patches are unnecessary.
The wasm_wasi development profile enables only the compiler features this
host can use, retaining the upstream backend and linker implementations.
The patch also preserves the parent's inheritable WASI rights when opening
child directories (needed for std and cache files) and uses streaming
standard output for env, targets, and fmt so pipes need no seek capability.
compiler_rt is linked as a relocatable object because the self-hosted Wasm
linker cannot emit the static archive used by a native LLVM-enabled compiler.
Relocatable objects retain required target_features metadata even when
stripped or built for the MVP CPU with no optional features.

Kudos to Auguste Rame and erikarvstedt, and to the Zig contributors.
Official release metadata: https://ziglang.org/download/index.json
