//! Windows 底向上位图的图块复制与变化校验；所有坐标和长度在切片内验证。

struct Region {
    first_row: usize,
    stride_bytes: usize,
    column_bytes: usize,
    row_bytes: usize,
    required_bytes: usize,
}

#[allow(clippy::too_many_arguments)]
fn region(
    source: &[u8],
    screen_width: usize,
    screen_height: usize,
    pixel_bytes: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> Option<Region> {
    if !matches!(pixel_bytes, 3 | 4)
        || width == 0
        || height == 0
        || x.checked_add(width)? > screen_width
        || y.checked_add(height)? > screen_height
    {
        return None;
    }
    let stride_bytes = screen_width.checked_mul(pixel_bytes)?;
    let column_bytes = x.checked_mul(pixel_bytes)?;
    let row_bytes = width.checked_mul(pixel_bytes)?;
    let required_bytes = row_bytes.checked_mul(height)?;
    let first_row = screen_height - y - height;
    let last_end = (first_row + height - 1)
        .checked_mul(stride_bytes)?
        .checked_add(column_bytes)?
        .checked_add(row_bytes)?;
    (last_end <= source.len()).then_some(Region {
        first_row,
        stride_bytes,
        column_bytes,
        row_bytes,
        required_bytes,
    })
}

/// 复制底向上位图中的图块；失败时目标保持原样。
#[allow(clippy::too_many_arguments)]
pub fn copy_tile(
    destination: &mut [u8],
    source: &[u8],
    screen_width: usize,
    screen_height: usize,
    pixel_bytes: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> bool {
    let Some(region) = region(
        source,
        screen_width,
        screen_height,
        pixel_bytes,
        x,
        y,
        width,
        height,
    ) else {
        return false;
    };
    if destination.len() < region.required_bytes {
        return false;
    }
    for (row, target) in destination[..region.required_bytes]
        .chunks_exact_mut(region.row_bytes)
        .enumerate()
    {
        let start = (region.first_row + row) * region.stride_bytes + region.column_bytes;
        target.copy_from_slice(&source[start..start + region.row_bytes]);
    }
    true
}

/// 沿用 Windows 原有按四字节分组的校验算法，以保持运行期变化判断一致。
#[allow(clippy::too_many_arguments)]
pub fn checksum_tile(
    source: &[u8],
    screen_width: usize,
    screen_height: usize,
    pixel_bytes: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> Option<u32> {
    let region = region(
        source,
        screen_width,
        screen_height,
        pixel_bytes,
        x,
        y,
        width,
        height,
    )?;
    let mut checksum = 0u32;
    for row in 0..height {
        let start = (region.first_row + row) * region.stride_bytes + region.column_bytes;
        for word in source[start..start + region.row_bytes].as_chunks::<4>().0 {
            checksum = checksum.wrapping_mul(0x0100_0193) ^ u32::from_le_bytes(*word);
        }
    }
    Some(checksum)
}
