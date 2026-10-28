const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const cwd = std.Io.Dir.cwd();
    var source = try cwd.openDir(io, "source", .{});
    defer source.close(io);
    var nested = try source.openDir(io, "nested", .{});
    defer nested.close(io);
    const input = try nested.readFileAlloc(io, "input.txt", init.gpa, .limited(1024));
    defer init.gpa.free(input);
    if (!std.mem.eql(u8, input, "read nested input\n")) return error.WrongInput;

    var cache = try cwd.createDirPathOpen(io, "cache/a/b", .{});
    defer cache.close(io);
    var file = try cache.createFile(io, "manifest", .{ .read = true });
    defer file.close(io);
    try file.writePositionalAll(io, "write nested cache\n", 0);
    var buffer: [128]u8 = undefined;
    const read_len = try file.readPositionalAll(io, &buffer, 0);
    if (!std.mem.eql(u8, buffer[0..read_len], "write nested cache\n")) return error.WrongCache;

    var parent_stat: std.os.wasi.fdstat_t = undefined;
    var child_stat: std.os.wasi.fdstat_t = undefined;
    if (std.os.wasi.fd_fdstat_get(cwd.handle, &parent_stat) != .SUCCESS) return error.StatParent;
    if (std.os.wasi.fd_fdstat_get(nested.handle, &child_stat) != .SUCCESS) return error.StatChild;
    if (parent_stat.fs_rights_inheriting != child_stat.fs_rights_inheriting) return error.ChangedRights;
    var restricted = try cwd.openDir(io, "source", .{ .access_sub_paths = false });
    defer restricted.close(io);
    if (std.os.wasi.fd_fdstat_get(restricted.handle, &child_stat) != .SUCCESS) return error.StatRestricted;
    if (child_stat.fs_rights_inheriting != @as(std.os.wasi.rights_t, .{})) return error.RestrictedInheritedRights;

    var stdout_buffer: [256]u8 = undefined;
    var writer = std.Io.File.stdout().writerStreaming(io, &stdout_buffer);
    try writer.interface.writeAll("PASS: nested read, nested create, positional read/write, inherited rights, restricted rights\n");
    try writer.interface.flush();
}
