//! RGB24 桌面帧的有界 tile 提取；不持有屏幕或输出缓冲区。

/// 从带行填充的 RGB24 桌面帧复制一个 tile。
/// 先检查全部行和输出容量，失败时不修改目标。
pub fn copy_rgb24_tile(
    destination: &mut [u8],
    desktop: &[u8],
    stride_pixels: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> bool {
    if width == 0 || height == 0 || x.checked_add(width).is_none_or(|end| end > stride_pixels) {
        return false;
    }
    let Some(row_bytes) = width.checked_mul(3) else {
        return false;
    };
    let Some(required) = row_bytes.checked_mul(height) else {
        return false;
    };
    let Some(stride_bytes) = stride_pixels.checked_mul(3) else {
        return false;
    };
    let Some(last_row) = y.checked_add(height - 1) else {
        return false;
    };
    let Some(last_end) = last_row
        .checked_mul(stride_bytes)
        .and_then(|offset| {
            x.checked_mul(3)
                .and_then(|column| offset.checked_add(column))
        })
        .and_then(|offset| offset.checked_add(row_bytes))
    else {
        return false;
    };
    if destination.len() < required || desktop.len() < last_end {
        return false;
    }
    for (row, target) in destination[..required]
        .chunks_exact_mut(row_bytes)
        .enumerate()
    {
        let offset = (y + row) * stride_bytes + x * 3;
        target.copy_from_slice(&desktop[offset..offset + row_bytes]);
    }
    true
}

/// 只读取 tile 内的 RGB24 字节；每个完整四字节块执行一次旧版的 FNV 乘法，
/// 不再把行尾后一字节或相邻 tile 纳入校验。
pub fn checksum_rgb24_tile(
    desktop: &[u8],
    stride_pixels: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> Option<u32> {
    if width == 0 || height == 0 || x.checked_add(width)? > stride_pixels {
        return None;
    }
    let row_bytes = width.checked_mul(3)?;
    let stride_bytes = stride_pixels.checked_mul(3)?;
    let row_start = y.checked_add(height - 1)?.checked_mul(stride_bytes)?;
    let last_end = row_start
        .checked_add(x.checked_mul(3)?)?
        .checked_add(row_bytes)?;
    if desktop.len() < last_end {
        return None;
    }
    let mut checksum = 0u32;
    for offset in 0..height {
        let start = (y + offset) * stride_bytes + x * 3;
        let bytes = &desktop[start..start + row_bytes];
        let (words, remaining) = bytes.as_chunks::<4>();
        for word in words {
            checksum = checksum.wrapping_mul(0x0100_0193) ^ u32::from_le_bytes(*word);
        }
        if !remaining.is_empty() {
            let mut tail = [0u8; 4];
            tail[..remaining.len()].copy_from_slice(remaining);
            checksum = checksum.wrapping_mul(0x0100_0193) ^ u32::from_le_bytes(tail);
        }
    }
    Some(checksum)
}
