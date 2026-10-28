const wasi = @import("std").os.wasi;

pub fn main() u8 {
    const message = "zigc-wasm 0.17.0\n";
    const vectors = [_]wasi.ciovec_t{.{ .base = message.ptr, .len = message.len }};
    var written: usize = 0;
    if (wasi.fd_write(1, &vectors, vectors.len, &written) != .SUCCESS) return 1;
    return if (written == message.len) 0 else 2;
}
