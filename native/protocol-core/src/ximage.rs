//! XImage 原始像素到带填充 RGB24 桌面帧的有界转换。

#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub width: usize,
    pub height: usize,
    pub source_stride: usize,
    pub output_stride: usize,
    pub output_height: usize,
    pub bits_per_pixel: u32,
    pub big_endian: bool,
    pub masks: [u32; 3],
}

fn channel(pixel: u32, mask: u32) -> u8 {
    let shift = mask.trailing_zeros();
    let bits = mask.count_ones();
    let value = (pixel & mask) >> shift;
    if bits >= 8 {
        (value >> (bits - 8)) as u8
    } else {
        (value << (8 - bits)) as u8
    }
}

/// 输入、输出和三个通道掩码先整体校验；失败时目标保持原样。
pub fn copy_rgb24(destination: &mut [u8], source: &[u8], format: Format) -> bool {
    let Format {
        width,
        height,
        source_stride,
        output_stride,
        output_height,
        bits_per_pixel,
        big_endian,
        masks,
    } = format;
    if width == 0
        || height == 0
        || width > output_stride
        || height > output_height
        || !matches!(bits_per_pixel, 16 | 24 | 32)
    {
        return false;
    }
    let bytes_per_pixel = bits_per_pixel as usize / 8;
    let Some(source_row) = width.checked_mul(bytes_per_pixel) else {
        return false;
    };
    let Some(output_row) = output_stride.checked_mul(3) else {
        return false;
    };
    let Some(source_len) = source_stride.checked_mul(height) else {
        return false;
    };
    let Some(output_len) = output_row.checked_mul(output_height) else {
        return false;
    };
    if source_stride < source_row || source.len() < source_len || destination.len() < output_len {
        return false;
    }
    let limit = if bits_per_pixel == 32 {
        u32::MAX
    } else {
        (1u32 << bits_per_pixel) - 1
    };
    if masks.iter().any(|mask| {
        *mask == 0 || *mask & !limit != 0 || {
            let normalized = *mask >> mask.trailing_zeros();
            normalized & normalized.wrapping_add(1) != 0
        }
    }) || masks[0] & masks[1] != 0
        || masks[0] & masks[2] != 0
        || masks[1] & masks[2] != 0
    {
        return false;
    }

    let common_bgr = masks == [0xff0000, 0xff00, 0xff] && !big_endian;
    for row in 0..height {
        let input = &source[row * source_stride..row * source_stride + source_row];
        let row_start = row * output_row;
        let (output, padding) =
            destination[row_start..row_start + output_row].split_at_mut(width * 3);
        padding.fill(0);
        if common_bgr && bits_per_pixel == 32 {
            for (pixel, rgb) in input
                .as_chunks::<4>()
                .0
                .iter()
                .zip(output.as_chunks_mut::<3>().0)
            {
                *rgb = [pixel[2], pixel[1], pixel[0]];
            }
            continue;
        }
        if common_bgr && bits_per_pixel == 24 {
            for (pixel, rgb) in input
                .as_chunks::<3>()
                .0
                .iter()
                .zip(output.as_chunks_mut::<3>().0)
            {
                *rgb = [pixel[2], pixel[1], pixel[0]];
            }
            continue;
        }
        if !big_endian && bits_per_pixel == 16 && masks == [0xf800, 0x07e0, 0x001f] {
            for (pixel, rgb) in input
                .as_chunks::<2>()
                .0
                .iter()
                .zip(output.as_chunks_mut::<3>().0)
            {
                let value = u16::from_le_bytes(*pixel);
                *rgb = [
                    ((value >> 11) as u8) << 3,
                    (((value >> 5) & 0x3f) as u8) << 2,
                    ((value & 0x1f) as u8) << 3,
                ];
            }
            continue;
        }
        for (bytes, rgb) in input
            .chunks_exact(bytes_per_pixel)
            .zip(output.as_chunks_mut::<3>().0)
        {
            let pixel = match (bits_per_pixel, big_endian) {
                (16, false) => u16::from_le_bytes([bytes[0], bytes[1]]) as u32,
                (16, true) => u16::from_be_bytes([bytes[0], bytes[1]]) as u32,
                (24, false) => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0]),
                (24, true) => u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]),
                (32, false) => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                (32, true) => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                _ => unreachable!(),
            };
            rgb[0] = channel(pixel, masks[0]);
            rgb[1] = channel(pixel, masks[1]);
            rgb[2] = channel(pixel, masks[2]);
        }
    }
    // 有效像素已逐字节覆盖，只需清空未采集的底部填充行。
    destination[height * output_row..output_len].fill(0);
    true
}

/// 在已转换的 RGB24 帧上叠加 XFixes ARGB 光标；透明度超过 128 时反转颜色。
/// 无效输入不会改变桌面帧。
#[derive(Clone, Copy, Debug)]
pub struct CursorFormat {
    pub stride_pixels: usize,
    pub width: usize,
    pub height: usize,
    pub cursor_width: usize,
    pub cursor_height: usize,
    pub pixel_bytes: usize,
    pub origin_x: i32,
    pub origin_y: i32,
}

pub fn overlay_cursor_rgb24(destination: &mut [u8], cursor: &[u8], format: CursorFormat) -> bool {
    let CursorFormat {
        stride_pixels,
        width,
        height,
        cursor_width,
        cursor_height,
        pixel_bytes,
        origin_x,
        origin_y,
    } = format;
    let Some(destination_len) = stride_pixels
        .checked_mul(height)
        .and_then(|n| n.checked_mul(3))
    else {
        return false;
    };
    let Some(cursor_len) = cursor_width
        .checked_mul(cursor_height)
        .and_then(|n| n.checked_mul(pixel_bytes))
    else {
        return false;
    };
    if width > stride_pixels
        || !matches!(pixel_bytes, 4 | 8)
        || destination.len() < destination_len
        || cursor.len() < cursor_len
    {
        return false;
    }
    for row in 0..cursor_height {
        let dy = i64::from(origin_y) + row as i64;
        if dy < 0 || dy >= height as i64 {
            continue;
        }
        for col in 0..cursor_width {
            let dx = i64::from(origin_x) + col as i64;
            if dx < 0 || dx >= width as i64 {
                continue;
            }
            let source = (row * cursor_width + col) * pixel_bytes;
            let alpha = if pixel_bytes == 4 {
                u32::from_ne_bytes(cursor[source..source + 4].try_into().unwrap()) >> 24
            } else {
                u64::from_ne_bytes(cursor[source..source + 8].try_into().unwrap()) as u32 >> 24
            };
            if alpha > 128 {
                let target = (dy as usize * stride_pixels + dx as usize) * 3;
                for value in &mut destination[target..target + 3] {
                    *value = 255 - *value;
                }
            }
        }
    }
    true
}
