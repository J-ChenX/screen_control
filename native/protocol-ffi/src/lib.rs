//! MeshAgent 的最小 C ABI；所有裸指针操作仅位于本模块。
#![deny(unsafe_op_in_unsafe_fn)]

mod lifecycle;

use screen_control_protocol::{Header, mask_copy, mask_in_place, parse_header};

#[repr(C)]
pub struct XImageMeta {
    pub width: u32,
    pub height: u32,
    pub source_stride: u32,
    pub output_stride: u32,
    pub output_height: u32,
    pub bits_per_pixel: u32,
    pub byte_order: u32,
    pub reserved: u32,
    pub red_mask: u64,
    pub green_mask: u64,
    pub blue_mask: u64,
}

/// XImage 输入在 C 端仍由 XShm 拥有；本调用只在同步期间借用。
///
/// # Safety
/// source 必须覆盖 source_len 字节，destination 必须独占且覆盖 destination_len 字节；
/// 两个区域不能重叠，调用期间不能被其他线程修改。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ximage_rgb24(
    destination: *mut u8,
    destination_len: u64,
    source: *const u8,
    source_len: u64,
    meta: XImageMeta,
) -> u32 {
    if destination.is_null()
        || source.is_null()
        || meta.reserved != 0
        || meta.byte_order > 1
        || meta.red_mask > u32::MAX as u64
        || meta.green_mask > u32::MAX as u64
        || meta.blue_mask > u32::MAX as u64
    {
        return 0;
    }
    let (Ok(destination_len), Ok(source_len)) = (
        usize::try_from(destination_len),
        usize::try_from(source_len),
    ) else {
        return 0;
    };
    if destination_len == 0
        || source_len == 0
        || destination_len > isize::MAX as usize
        || source_len > isize::MAX as usize
    {
        return 0;
    }
    let (Some(destination_end), Some(source_end)) = (
        (destination as usize).checked_add(destination_len),
        (source as usize).checked_add(source_len),
    ) else {
        return 0;
    };
    if (destination as usize) < source_end && (source as usize) < destination_end {
        return 0;
    }
    // 安全依据：C 保证内存真实有效；上述检查拒绝空指针、过长切片和别名。
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, destination_len) };
    let source = unsafe { core::slice::from_raw_parts(source, source_len) };
    let format = screen_control_protocol::ximage::Format {
        width: meta.width as usize,
        height: meta.height as usize,
        source_stride: meta.source_stride as usize,
        output_stride: meta.output_stride as usize,
        output_height: meta.output_height as usize,
        bits_per_pixel: meta.bits_per_pixel,
        big_endian: meta.byte_order == 1,
        masks: [
            meta.red_mask as u32,
            meta.green_mask as u32,
            meta.blue_mask as u32,
        ],
    };
    u32::from(screen_control_protocol::ximage::copy_rgb24(
        destination,
        source,
        format,
    ))
}

#[repr(C)]
pub struct CursorMeta {
    pub stride_pixels: u32,
    pub width: u32,
    pub height: u32,
    pub cursor_width: u32,
    pub cursor_height: u32,
    pub pixel_bytes: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

/// # Safety
/// 两个区域必须在给定长度内有效且不重叠，目标在调用期间独占可写。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_cursor_overlay_rgb24(
    destination: *mut u8,
    destination_len: u64,
    cursor: *const u8,
    cursor_len: u64,
    meta: CursorMeta,
) -> u32 {
    if destination.is_null() || cursor.is_null() {
        return 0;
    }
    let (Ok(destination_len), Ok(cursor_len)) = (
        usize::try_from(destination_len),
        usize::try_from(cursor_len),
    ) else {
        return 0;
    };
    if destination_len == 0
        || cursor_len == 0
        || destination_len > isize::MAX as usize
        || cursor_len > isize::MAX as usize
    {
        return 0;
    }
    let (Some(destination_end), Some(cursor_end)) = (
        (destination as usize).checked_add(destination_len),
        (cursor as usize).checked_add(cursor_len),
    ) else {
        return 0;
    };
    if (destination as usize) < cursor_end && (cursor as usize) < destination_end {
        return 0;
    }
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, destination_len) };
    let cursor = unsafe { core::slice::from_raw_parts(cursor, cursor_len) };
    let format = screen_control_protocol::ximage::CursorFormat {
        stride_pixels: meta.stride_pixels as usize,
        width: meta.width as usize,
        height: meta.height as usize,
        cursor_width: meta.cursor_width as usize,
        cursor_height: meta.cursor_height as usize,
        pixel_bytes: meta.pixel_bytes as usize,
        origin_x: meta.origin_x,
        origin_y: meta.origin_y,
    };
    u32::from(screen_control_protocol::ximage::overlay_cursor_rgb24(
        destination,
        cursor,
        format,
    ))
}

/// 将 C 的有符号屏幕尺寸与长度校验后交给安全的 tile 提取器。
///
/// # Safety
/// 两个非空区域在调用期间必须有效且不重叠；目标必须独占可写。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_tile_copy_rgb24(
    destination: *mut u8,
    destination_len: u64,
    desktop: *const u8,
    desktop_len: u64,
    screen_width: i32,
    tile_width: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> u32 {
    let [screen_width, tile_width, x, y, width, height] =
        [screen_width, tile_width, x, y, width, height];
    if [screen_width, tile_width, width, height]
        .iter()
        .any(|value| *value <= 0)
        || x < 0
        || y < 0
        || destination.is_null()
        || desktop.is_null()
    {
        return 0;
    }
    let Some(stride) = (screen_width as usize)
        .checked_add(tile_width as usize - 1)
        .map(|value| value / tile_width as usize * tile_width as usize)
    else {
        return 0;
    };
    let (Ok(destination_len), Ok(desktop_len)) = (
        usize::try_from(destination_len),
        usize::try_from(desktop_len),
    ) else {
        return 0;
    };
    if destination_len > isize::MAX as usize || desktop_len > isize::MAX as usize {
        return 0;
    }
    let (Some(destination_end), Some(desktop_end)) = (
        (destination as usize).checked_add(destination_len),
        (desktop as usize).checked_add(desktop_len),
    ) else {
        return 0;
    };
    if (destination as usize) < desktop_end && (desktop as usize) < destination_end {
        return 0;
    }
    // 安全依据：空指针、长度和重叠已拒绝；实际有效性由 C 调用点保证。
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, destination_len) };
    let desktop = unsafe { core::slice::from_raw_parts(desktop, desktop_len) };
    u32::from(screen_control_protocol::tile::copy_rgb24_tile(
        destination,
        desktop,
        stride,
        x as usize,
        y as usize,
        width as usize,
        height as usize,
    ))
}

/// 校验值写入 checksum；失败时不修改它。
///
/// # Safety
/// desktop 必须覆盖 desktop_len 字节；checksum 必须对齐、可写且不与 desktop 重叠。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_tile_crc_rgb24(
    desktop: *const u8,
    desktop_len: u64,
    screen_width: i32,
    tile_width: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    checksum: *mut u32,
) -> u32 {
    if desktop.is_null()
        || checksum.is_null()
        || !checksum.is_aligned()
        || screen_width <= 0
        || tile_width <= 0
        || x < 0
        || y < 0
        || width <= 0
        || height <= 0
    {
        return 0;
    }
    let Some(stride) = (screen_width as usize)
        .checked_add(tile_width as usize - 1)
        .map(|value| value / tile_width as usize * tile_width as usize)
    else {
        return 0;
    };
    let Ok(desktop_len) = usize::try_from(desktop_len) else {
        return 0;
    };
    if desktop_len == 0 || desktop_len > isize::MAX as usize {
        return 0;
    }
    let (Some(desktop_end), Some(checksum_end)) = (
        (desktop as usize).checked_add(desktop_len),
        (checksum as usize).checked_add(core::mem::size_of::<u32>()),
    ) else {
        return 0;
    };
    if (desktop as usize) < checksum_end && (checksum as usize) < desktop_end {
        return 0;
    }
    // 安全依据：实际内存有效性由 C 保证，已检查长度、对齐和输出别名。
    let desktop = unsafe { core::slice::from_raw_parts(desktop, desktop_len) };
    let Some(value) = screen_control_protocol::tile::checksum_rgb24_tile(
        desktop,
        stride,
        x as usize,
        y as usize,
        width as usize,
        height as usize,
    ) else {
        return 0;
    };
    unsafe { checksum.write(value) };
    1
}

/// Windows 底向上位图同步借用；失败时不修改目标。
///
/// # Safety
/// 两个区域必须真实有效且不重叠，目标必须独占可写。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_win_tile_copy(
    destination: *mut u8,
    destination_len: u64,
    desktop: *const u8,
    desktop_len: u64,
    screen_width: i32,
    screen_height: i32,
    pixel_bytes: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> u32 {
    if destination.is_null()
        || desktop.is_null()
        || [screen_width, screen_height, pixel_bytes, width, height]
            .iter()
            .any(|value| *value <= 0)
        || x < 0
        || y < 0
    {
        return 0;
    }
    let (Ok(destination_len), Ok(desktop_len)) = (
        usize::try_from(destination_len),
        usize::try_from(desktop_len),
    ) else {
        return 0;
    };
    if destination_len == 0
        || desktop_len == 0
        || destination_len > isize::MAX as usize
        || desktop_len > isize::MAX as usize
    {
        return 0;
    }
    let (Some(destination_end), Some(desktop_end)) = (
        (destination as usize).checked_add(destination_len),
        (desktop as usize).checked_add(desktop_len),
    ) else {
        return 0;
    };
    if (destination as usize) < desktop_end && (desktop as usize) < destination_end {
        return 0;
    }
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, destination_len) };
    let desktop = unsafe { core::slice::from_raw_parts(desktop, desktop_len) };
    u32::from(screen_control_protocol::windows_tile::copy_tile(
        destination,
        desktop,
        screen_width as usize,
        screen_height as usize,
        pixel_bytes as usize,
        x as usize,
        y as usize,
        width as usize,
        height as usize,
    ))
}

/// Windows 底向上位图校验；失败时不修改校验值。
///
/// # Safety
/// 桌面区域必须真实有效；checksum 必须对齐、可写且不与桌面区域重叠。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_win_tile_crc(
    desktop: *const u8,
    desktop_len: u64,
    screen_width: i32,
    screen_height: i32,
    pixel_bytes: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    checksum: *mut u32,
) -> u32 {
    if desktop.is_null()
        || checksum.is_null()
        || !checksum.is_aligned()
        || [screen_width, screen_height, pixel_bytes, width, height]
            .iter()
            .any(|value| *value <= 0)
        || x < 0
        || y < 0
    {
        return 0;
    }
    let Ok(desktop_len) = usize::try_from(desktop_len) else {
        return 0;
    };
    if desktop_len == 0 || desktop_len > isize::MAX as usize {
        return 0;
    }
    let (Some(desktop_end), Some(checksum_end)) = (
        (desktop as usize).checked_add(desktop_len),
        (checksum as usize).checked_add(core::mem::size_of::<u32>()),
    ) else {
        return 0;
    };
    if (desktop as usize) < checksum_end && (checksum as usize) < desktop_end {
        return 0;
    }
    let desktop = unsafe { core::slice::from_raw_parts(desktop, desktop_len) };
    let Some(value) = screen_control_protocol::windows_tile::checksum_tile(
        desktop,
        screen_width as usize,
        screen_height as usize,
        pixel_bytes as usize,
        x as usize,
        y as usize,
        width as usize,
        height as usize,
    ) else {
        return 0;
    };
    unsafe { checksum.write(value) };
    1
}

#[repr(C)]
pub struct HeaderBytes {
    pub bytes: [u8; 14],
    pub count: u8,
    pub reserved: u8,
}

#[repr(C)]
#[derive(Default)]
pub struct ParsedFrame {
    pub status: u32,
    pub header_len: u32,
    pub payload_len: u32,
    pub flags: u32,
    pub mask: u32,
}

/// 按值传递最多 14 字节；status：0 等待、1 完整帧、2 非法。
#[unsafe(no_mangle)]
pub extern "C" fn sc_ws_parse(header: HeaderBytes, available: u32) -> ParsedFrame {
    sc_ws_parse_extensions(header, available, 0)
}

/// 仅允许显式协商的 permessage-deflate 首数据帧使用 RSV1；不改变旧入口契约。
#[unsafe(no_mangle)]
pub extern "C" fn sc_ws_parse_extensions(
    mut header: HeaderBytes,
    available: u32,
    deflate: u32,
) -> ParsedFrame {
    let invalid = || ParsedFrame {
        status: 2,
        ..Default::default()
    };
    if header.count > 14
        || u32::from(header.count) > available
        || header.reserved != 0
        || deflate > 1
    {
        return invalid();
    }
    let compressed = header.count > 0 && header.bytes[0] & 0x40 != 0;
    if compressed {
        if deflate == 0 || !matches!(header.bytes[0] & 15, 1 | 2) {
            return invalid();
        }
        header.bytes[0] &= !0x40;
    }
    match parse_header(&header.bytes[..usize::from(header.count)]) {
        Header::Invalid => invalid(),
        Header::Incomplete => ParsedFrame::default(),
        Header::Complete(frame) => {
            let Some(total) = frame.header_len.checked_add(frame.payload_len) else {
                return invalid();
            };
            if total > available {
                return ParsedFrame::default();
            }
            ParsedFrame {
                status: 1,
                header_len: frame.header_len,
                payload_len: frame.payload_len,
                flags: u32::from(frame.opcode)
                    | if compressed { 0x200 } else { 0 }
                    | if frame.fin { 0x80 } else { 0 }
                    | if frame.mask.is_some() { 0x100 } else { 0 },
                mask: u32::from_le_bytes(frame.mask.unwrap_or_default()),
            }
        }
    }
}

/// 原地转换完整正文；不保存指针，不调用外部代码。
///
/// # Safety
/// 非空时 data 必须指向 length 字节的独占可写区域，调用期间不得并发访问。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_mask(data: *mut u8, length: u32, key: u32) -> u32 {
    if length == 0 {
        return 1;
    }
    if data.is_null() || u64::from(length) > screen_control_protocol::MAX_PAYLOAD {
        return 0;
    }
    // 安全依据：调用方保证区域有效且独占，长度已受限并可表示为 isize。
    let data = unsafe { core::slice::from_raw_parts_mut(data, length as usize) };
    mask_in_place(data, key.to_le_bytes());
    1
}

/// 复制并转换正文；两个区域不允许重叠。
///
/// # Safety
/// source 必须可读 length 字节，destination 必须独占可写相同字节数。
/// 两个区域在调用期间保持有效且没有并发写入。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_mask_copy(
    destination: *mut u8,
    source: *const u8,
    length: u32,
    key: u32,
) -> u32 {
    if length == 0 {
        return 1;
    }
    if destination.is_null()
        || source.is_null()
        || u64::from(length) > screen_control_protocol::MAX_PAYLOAD
    {
        return 0;
    }
    let count = length as usize;
    let Some(destination_end) = (destination as usize).checked_add(count) else {
        return 0;
    };
    let Some(source_end) = (source as usize).checked_add(count) else {
        return 0;
    };
    if (destination as usize) < source_end && (source as usize) < destination_end {
        return 0;
    }
    // 安全依据：上方拒绝地址重叠；有效性与并发由 C 调用点保证。
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, count) };
    let source = unsafe { core::slice::from_raw_parts(source, count) };
    u32::from(mask_copy(destination, source, key.to_le_bytes()))
}
