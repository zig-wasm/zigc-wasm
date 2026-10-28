const std = @import("std");
const helper = @import("nested/debug-helper.zig");

pub fn main(init: std.process.Init) !void {
    var input_buffer: [64]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(init.io, &input_buffer);
    const line = (try stdin.interface.takeDelimiter('\n')) orelse "0";
    const value = try std.fmt.parseInt(i32, line, 10);
    const result = helper.addFive(value);
    var output_buffer: [64]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &output_buffer);
    try stdout.interface.print("result={d}\n", .{result});
    try stdout.interface.flush();
}
