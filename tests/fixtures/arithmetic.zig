const std = @import("std");

export fn add(left: i32, right: i32) i32 {
    return left + right;
}

export fn sum_to(limit: u32) u32 {
    var result: u32 = 0;
    var value: u32 = 1;
    while (value <= limit) : (value += 1) result += value;
    return result;
}

export fn rotate(value: u32) u32 {
    return std.math.rotl(u32, value, @as(u5, 5));
}

export fn divide_wide(high: u64, low: u64, divisor: u64) u64 {
    const numerator = (@as(u128, high) << 64) | @as(u128, low);
    return @intCast(numerator / @as(u128, divisor));
}
