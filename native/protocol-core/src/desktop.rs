//! 桌面编码尺寸、等比缩放与输入坐标映射；不改变物理桌面分辨率。
use alloc::vec::Vec;

/// 按 1440/1080/720/540 档位的边界等比缩小，低分辨率源不放大。
pub fn dimensions(width: u32, height: u32, tier: u32) -> Option<(u32, u32)> {
    if width == 0
        || height == 0
        || width > 65535
        || height > 65535
        || !matches!(tier, 1440 | 1080 | 720 | 540)
    {
        return None;
    }
    let max_width = tier * 16 / 9;
    if u64::from(width) * u64::from(tier) > u64::from(height) * u64::from(max_width) {
        let target_width = width.min(max_width);
        Some((
            target_width,
            ((u64::from(height) * u64::from(target_width) / u64::from(width)) as u32).max(1),
        ))
    } else {
        let target_height = height.min(tier);
        Some((
            ((u64::from(width) * u64::from(target_height) / u64::from(height)) as u32).max(1),
            target_height,
        ))
    }
}

/// 坐标按当前已展示画面的尺寸映射；边缘点夹到最后一个实际像素。
pub fn input_coordinate(value: u32, encoded: u32, source: u32) -> Option<u32> {
    if encoded == 0 || source == 0 || value > encoded {
        return None;
    }
    Some(((u64::from(value) * u64::from(source) / u64::from(encoded)) as u32).min(source - 1))
}

fn sample(position: usize, source: usize, target: usize) -> (usize, usize, u32) {
    // 像素中心对齐，8 位小数；边缘扩展避免缩小后的半像素偏移。
    let coordinate =
        (((2 * position + 1) as u64 * source as u64 * 128) / target as u64).saturating_sub(128);
    let left = (coordinate / 256) as usize;
    (
        left.min(source - 1),
        (left + 1).min(source - 1),
        (coordinate % 256) as u32,
    )
}

/// 对 RGB24 做有界双线性缩小；先整体检查，失败时不写入目标。
pub fn resize_rgb24(
    destination: &mut [u8],
    source: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    target_width: usize,
    target_height: usize,
) -> bool {
    if width == 0
        || height == 0
        || width > stride
        || target_width == 0
        || target_height == 0
        || target_width > width
        || target_height > height
        || target_width > 2560
        || target_height > 1440
    {
        return false;
    }
    let Some(source_length) = height
        .checked_sub(1)
        .and_then(|last| last.checked_mul(stride))
        .and_then(|offset| offset.checked_add(width))
        .and_then(|pixels| pixels.checked_mul(3))
    else {
        return false;
    };
    let Some(target_length) = target_width
        .checked_mul(target_height)
        .and_then(|pixels| pixels.checked_mul(3))
    else {
        return false;
    };
    if source.len() < source_length || destination.len() < target_length {
        return false;
    }
    if width == target_width && height == target_height {
        for row in 0..height {
            destination[row * width * 3..(row + 1) * width * 3]
                .copy_from_slice(&source[row * stride * 3..row * stride * 3 + width * 3]);
        }
        return true;
    }
    let columns: Vec<_> = (0..target_width)
        .map(|x| sample(x, width, target_width))
        .collect();
    for y in 0..target_height {
        let (top, bottom, fy) = sample(y, height, target_height);
        for (x, &(left, right, fx)) in columns.iter().enumerate() {
            for channel in 0..3 {
                let a = u32::from(source[(top * stride + left) * 3 + channel]);
                let b = u32::from(source[(top * stride + right) * 3 + channel]);
                let c = u32::from(source[(bottom * stride + left) * 3 + channel]);
                let d = u32::from(source[(bottom * stride + right) * 3 + channel]);
                destination[(y * target_width + x) * 3 + channel] =
                    (((a * (256 - fx) + b * fx) * (256 - fy)
                        + (c * (256 - fx) + d * fx) * fy
                        + 32768)
                        >> 16) as u8;
            }
        }
    }
    true
}

/// Windows 底向上 BGR 位图直接缩放到 RGB24；先检查填充、跨度和容量。
#[allow(clippy::too_many_arguments)]
pub fn resize_windows(
    destination: &mut [u8],
    source: &[u8],
    stride_bytes: usize,
    bitmap_height: usize,
    pixel_bytes: usize,
    width: usize,
    height: usize,
    target_width: usize,
    target_height: usize,
) -> bool {
    if !matches!(pixel_bytes, 3 | 4)
        || width == 0
        || height == 0
        || width > 65535
        || height > 65535
        || bitmap_height < height
        || bitmap_height > 65568
        || target_width == 0
        || target_height == 0
        || target_width > width
        || target_height > height
        || target_width > 2560
        || target_height > 1440
        || width
            .checked_mul(pixel_bytes)
            .is_none_or(|n| n > stride_bytes)
        || stride_bytes
            .checked_mul(bitmap_height)
            .is_none_or(|n| n > source.len())
        || target_width
            .checked_mul(target_height)
            .and_then(|n| n.checked_mul(3))
            .is_none_or(|n| n > destination.len())
    {
        return false;
    }
    let columns: Vec<_> = (0..target_width)
        .map(|x| sample(x, width, target_width))
        .collect();
    for y in 0..target_height {
        let (top, bottom, fy) = sample(y, height, target_height);
        for (x, &(left, right, fx)) in columns.iter().enumerate() {
            for channel in 0..3 {
                let read = |row: usize, col: usize| {
                    u32::from(
                        source[(bitmap_height - 1 - row) * stride_bytes + col * pixel_bytes + 2
                            - channel],
                    )
                };
                let (a, b, c, d) = (
                    read(top, left),
                    read(top, right),
                    read(bottom, left),
                    read(bottom, right),
                );
                destination[(y * target_width + x) * 3 + channel] =
                    (((a * (256 - fx) + b * fx) * (256 - fy)
                        + (c * (256 - fx) + d * fx) * fy
                        + 32768)
                        >> 16) as u8;
            }
        }
    }
    true
}
