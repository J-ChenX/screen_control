use screen_control_protocol::ximage::{CursorFormat, Format, copy_rgb24, overlay_cursor_rgb24};

fn format(bits: u32, source_stride: usize, masks: [u32; 3]) -> Format {
    Format {
        width: 2,
        height: 2,
        source_stride,
        output_stride: 4,
        output_height: 4,
        bits_per_pixel: bits,
        big_endian: false,
        masks,
    }
}

#[test]
fn rgb24_respects_source_row_padding_and_clears_output_padding() {
    let input = [
        3, 2, 1, 6, 5, 4, 0xee, 0xee, 9, 8, 7, 12, 11, 10, 0xee, 0xee,
    ];
    let mut output = [0xa5; 48];
    assert!(copy_rgb24(
        &mut output,
        &input,
        format(24, 8, [0xff0000, 0xff00, 0xff])
    ));
    assert_eq!(&output[..12], &[1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&output[12..24], &[7, 8, 9, 10, 11, 12, 0, 0, 0, 0, 0, 0]);
    assert!(output[24..].iter().all(|byte| *byte == 0));
}

#[test]
fn rgb16_and_rgb32_decode_both_byte_orders() {
    let masks16 = [0xf800, 0x07e0, 0x001f];
    for (big_endian, source) in [
        (false, [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0xff, 0xff]),
        (true, [0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff]),
    ] {
        let mut output = [0; 48];
        let mut spec = format(16, 4, masks16);
        spec.big_endian = big_endian;
        assert!(copy_rgb24(&mut output, &source, spec));
        assert_eq!(&output[..6], &[248, 0, 0, 0, 252, 0]);
        assert_eq!(&output[12..18], &[0, 0, 248, 248, 252, 248]);
    }
    let source32 = [3, 2, 1, 0, 6, 5, 4, 0, 9, 8, 7, 0, 12, 11, 10, 0];
    let mut output = [0; 48];
    assert!(copy_rgb24(
        &mut output,
        &source32,
        format(32, 8, [0xff0000, 0xff00, 0xff])
    ));
    assert_eq!(&output[..6], &[1, 2, 3, 4, 5, 6]);
    assert_eq!(&output[12..18], &[7, 8, 9, 10, 11, 12]);
}

#[test]
fn invalid_geometry_masks_and_short_buffers_leave_output_unchanged() {
    let source = [0; 16];
    let original = [0xa5; 48];
    for spec in [
        format(24, 5, [0xff0000, 0xff00, 0xff]),
        format(24, 8, [0xff0000, 0xff0000, 0xff]),
        format(24, 8, [0xf0f000, 0xff00, 0xff]),
        format(24, 8, [0, 0xff00, 0xff]),
        format(8, 8, [0xff0000, 0xff00, 0xff]),
        Format {
            output_stride: 1,
            ..format(24, 8, [0xff0000, 0xff00, 0xff])
        },
    ] {
        let mut output = original;
        assert!(!copy_rgb24(&mut output, &source, spec));
        assert_eq!(output, original);
    }
    let mut output = original;
    assert!(!copy_rgb24(
        &mut output,
        &source[..15],
        format(24, 8, [0xff0000, 0xff00, 0xff])
    ));
    assert_eq!(output, original);
}

#[test]
fn cursor_overlay_clips_and_rejects_short_pixels() {
    let mut frame = [10u8; 4 * 3 * 3];
    let pixels = [0x81010203u32, 0x80010203, 0xff010203, 0x00010203];
    let bytes: Vec<u8> = pixels
        .iter()
        .flat_map(|pixel| pixel.to_ne_bytes())
        .collect();
    let mut cursor_format = CursorFormat {
        stride_pixels: 4,
        width: 3,
        height: 3,
        cursor_width: 2,
        cursor_height: 2,
        pixel_bytes: 4,
        origin_x: -1,
        origin_y: 1,
    };
    assert!(overlay_cursor_rgb24(&mut frame, &bytes, cursor_format));
    assert_eq!(&frame[12..15], &[10, 10, 10]);
    assert_eq!(&frame[24..27], &[10, 10, 10]);
    assert_eq!(&frame[27..30], &[10, 10, 10]);
    // 第二行最左侧不透明像素被裁掉，第二行右侧透明像素保持原样。
    let mut frame2 = [10u8; 4 * 3 * 3];
    cursor_format.origin_x = 0;
    cursor_format.origin_y = 0;
    assert!(overlay_cursor_rgb24(&mut frame2, &bytes, cursor_format));
    assert_eq!(&frame2[0..3], &[245, 245, 245]);
    assert_eq!(&frame2[3..6], &[10, 10, 10]);
    assert_eq!(&frame2[12..15], &[245, 245, 245]);
    assert_eq!(&frame2[15..18], &[10, 10, 10]);
    let original = frame2;
    assert!(!overlay_cursor_rgb24(
        &mut frame2,
        &bytes[..15],
        cursor_format
    ));
    assert_eq!(frame2, original);
    let words: Vec<u8> = pixels
        .iter()
        .flat_map(|pixel| (*pixel as u64).to_ne_bytes())
        .collect();
    cursor_format.pixel_bytes = 8;
    cursor_format.origin_x = 1;
    cursor_format.origin_y = 1;
    assert!(overlay_cursor_rgb24(&mut frame2, &words, cursor_format));
    assert_eq!(&frame2[15..18], &[245, 245, 245]);
}
