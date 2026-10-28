#!/usr/bin/env python3
"""Build the pinned Zig 0.17.0 compiler for WASI (Python 3.10+, Git required)."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.17.0"
SHA256 = {
    "zig-0.17.0": "b6c7f1728f043700d6529bac980800792f824256a9d2f1839b3d62beed0b8abd",
    "zig-x86_64-linux-0.17.0": "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026",
    "zig-aarch64-linux-0.17.0": "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8",
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def archive(work, name):
    destination = work / (name + ".tar.xz")
    if not destination.exists():
        url = f"https://ziglang.org/download/{VERSION}/{destination.name}"
        print(f"Downloading {url}", flush=True)
        with tempfile.NamedTemporaryFile(dir=work, delete=False) as tmp:
            temporary = Path(tmp.name)
            try:
                with urllib.request.urlopen(url, timeout=120) as response:
                    shutil.copyfileobj(response, tmp)
                tmp.close()
                if digest(temporary) != SHA256[name]:
                    raise RuntimeError(f"SHA-256 mismatch: {url}")
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
    if digest(destination) != SHA256[name]:
        raise RuntimeError(f"SHA-256 mismatch: {destination}; remove it and retry")
    return destination


def extract(archive_path, destination, top_level):
    # These pinned archives need only files and directories. Reject links and
    # traversal before extracting, including on Python versions without filters.
    with tarfile.open(archive_path, "r:xz") as tar:
        for member in tar.getmembers():
            path = Path(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != top_level
                or not (member.isfile() or member.isdir())
            ):
                raise RuntimeError(f"Unexpected archive member: {member.name}")
        tar.extractall(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=ROOT / ".build")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / VERSION)
    parser.add_argument("--zig", help="Existing native Zig 0.17.0 executable")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    work = args.work_dir.resolve()
    output = args.output.resolve()
    work.mkdir(parents=True, exist_ok=True)

    patch = ROOT / "zig" / f"{VERSION}.patch"
    patch_hash = digest(patch)
    source_name = f"zig-{VERSION}"
    source = work / (source_name + "-" + patch_hash[:16])
    if not source.exists():
        source_archive = archive(work, source_name)
        with tempfile.TemporaryDirectory(dir=work) as tmp:
            extract(source_archive, tmp, source_name)
            prepared = Path(tmp) / source_name
            # Without its own repository, git apply inside this checkout's
            # .build/ silently skips source-relative patch paths.
            subprocess.run(["git", "init", "--quiet"], cwd=prepared, check=True)
            subprocess.run(["git", "apply", "--check", str(patch)], cwd=prepared, check=True)
            subprocess.run(["git", "apply", str(patch)], cwd=prepared, check=True)
            prepared.rename(source)
    # Refuse a partially applied patch instead of silently compiling wrong code.
    subprocess.run(["git", "init", "--quiet"], cwd=source, check=True)
    subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=source, check=True)

    if args.zig:
        zig = Path(shutil.which(args.zig) or args.zig).resolve()
    else:
        machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(
            platform.machine().lower(), platform.machine().lower()
        )
        host = f"{machine}-{platform.system().lower()}"
        name = f"zig-{host}-{VERSION}"
        if name not in SHA256:
            parser.error("Automatic download supports Linux x86_64/aarch64; use --zig on other hosts")
        native = work / name
        if not native.exists():
            native_archive = archive(work, name)
            with tempfile.TemporaryDirectory(dir=work) as tmp:
                extract(native_archive, tmp, name)
                (Path(tmp) / name).rename(native)
        zig = native / "zig"
    version = subprocess.check_output([str(zig), "version"], text=True).strip()
    if version != VERSION:
        parser.error(f"Native Zig must be {VERSION}; found {version}")

    prefix = work / ("install-" + patch_hash[:16])
    command = [
        str(zig), "build",
        "-Dtarget=wasm32-wasi", "-Ddev=wasm_wasi",
        "-Denable-llvm=false", "-Dsingle-threaded=true",
        "-Doptimize=small", "-Dstrip=true", "-Dno-lib=true",
        f"-Dversion-string={VERSION}", f"-j{args.jobs}",
        "--prefix", str(prefix),
        "--cache-dir", str(work / "native-cache"),
    ]
    print("Building Zig 0.17.0 for wasm32-wasi", flush=True)
    environment = dict(os.environ)
    environment["ZIG_GLOBAL_CACHE_DIR"] = str(work / "global-cache")
    environment["ZIG_LIB_DIR"] = str(source / "lib")
    subprocess.run(command, cwd=source, env=environment, check=True)
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(prefix / "bin" / "zig.wasm", output / "zig.wasm")
    shutil.copytree(source / "lib", output / "lib", dirs_exist_ok=True)
    shutil.copy2(source / "LICENSE", output / "LICENSE")
    manifest = {
        "version": VERSION,
        "target": "wasm32-wasi",
        "source_sha256": SHA256[source_name],
        "patch_sha256": patch_hash,
        "wasm_sha256": digest(output / "zig.wasm"),
        "native_version": version,
    }
    (output / "build-info.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built {output / 'zig.wasm'}", flush=True)


if __name__ == "__main__":
    main()
