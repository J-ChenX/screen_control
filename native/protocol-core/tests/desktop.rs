use screen_control_protocol::desktop::{dimensions, input_coordinate, resize_rgb24};

#[test]
fn resolution_tiers_preserve_aspect_without_upscaling() {
    for (width, height) in [(2560, 1440), (3840, 2160), (1920, 1080)] {
        assert_eq!(dimensions(width, height, 1080), Some((1920, 1080)));
        assert_eq!(dimensions(width, height, 720), Some((1280, 720)));
        assert_eq!(dimensions(width, height, 540), Some((960, 540)));
    }
    assert_eq!(dimensions(2880, 1800, 1080), Some((1728, 1080)));
    assert_eq!(dimensions(800, 600, 1080), Some((800, 600)));
    assert_eq!(dimensions(0, 1440, 1080), None);
    assert_eq!(dimensions(2560, 1440, 999), None);
}
#[test]
fn resize_averages_pixels_and_rejects_short_buffers_without_writing() {
    let source = [0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255];
    let mut output = [7; 6];
    assert!(resize_rgb24(&mut output, &source, 2, 2, 2, 1, 1));
    assert_eq!(output, [139, 139, 139, 7, 7, 7]);
    let mut output = [7; 3];
    assert!(!resize_rgb24(&mut output, &source[..11], 2, 2, 2, 1, 1));
    assert_eq!(output, [7; 3]);
    assert!(!resize_rgb24(&mut output, &source, 2, 2, 2, 3, 1));
}
#[test]
fn pointer_coordinates_follow_presented_size_at_all_tiers() {
    for (encoded_width, encoded_height) in [(1920, 1080), (1280, 720), (960, 540)] {
        assert_eq!(
            input_coordinate(encoded_width / 2, encoded_width, 2560),
            Some(1280)
        );
        assert_eq!(
            input_coordinate(encoded_height / 2, encoded_height, 1440),
            Some(720)
        );
        assert_eq!(
            input_coordinate(encoded_width, encoded_width, 2560),
            Some(2559)
        );
    }
    assert_eq!(input_coordinate(1281, 1280, 2560), None);
    assert_eq!(input_coordinate(0, 0, 2560), None);
}

#[test]
fn high_quality_1440_preserves_native_pixels_and_caps_4k() {
    assert_eq!(dimensions(2560, 1440, 1440), Some((2560, 1440)));
    assert_eq!(dimensions(3840, 2160, 1440), Some((2560, 1440)));
    assert_eq!(dimensions(2880, 1800, 1440), Some((2304, 1440)));
    let source = [1, 2, 3, 4, 5, 6, 0, 0, 0, 7, 8, 9, 10, 11, 12, 0, 0, 0];
    let mut target = [0; 12];
    assert!(resize_rgb24(&mut target, &source, 3, 2, 2, 2, 2));
    assert_eq!(target, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
}

#[test]
fn windows_bitmap_orientation_padding_and_scaling_match_rgb() {
    use screen_control_protocol::desktop::resize_windows;
    for pixel in [3, 4] {
        let (width, height, padded_height, stride) = (5, 3, 4, 8 * pixel);
        let mut bitmap = vec![222; stride * padded_height];
        let mut rgb = vec![0; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                for c in 0..3 {
                    let v = (y * 60 + x * 9 + c * 2) as u8;
                    rgb[(y * width + x) * 3 + c] = v;
                    bitmap[(padded_height - 1 - y) * stride + x * pixel + 2 - c] = v;
                }
            }
        }
        for (tw, th) in [(5, 3), (3, 2), (1, 1)] {
            let mut expected = vec![0; tw * th * 3];
            let mut output = vec![7; tw * th * 3];
            assert!(resize_rgb24(
                &mut expected,
                &rgb,
                width,
                width,
                height,
                tw,
                th
            ));
            assert!(resize_windows(
                &mut output,
                &bitmap,
                stride,
                padded_height,
                pixel,
                width,
                height,
                tw,
                th
            ));
            assert_eq!(output, expected);
            output.fill(7);
            assert!(!resize_windows(
                &mut output,
                &bitmap[..bitmap.len() - 1],
                stride,
                padded_height,
                pixel,
                width,
                height,
                tw,
                th
            ));
            assert!(output.iter().all(|v| *v == 7));
        }
    }
    let mut output = [7; 3];
    for (stride, bh, pixel, width, height, tw, th) in [
        (1, 1, 3, 1, 1, 1, 1),
        (4, 0, 4, 1, 1, 1, 1),
        (4, 1, 2, 1, 1, 1, 1),
        (4, 1, 4, 1, 1, 2, 1),
        (usize::MAX, 2, 4, 1, 1, 1, 1),
    ] {
        assert!(!resize_windows(
            &mut output,
            &[0; 8],
            stride,
            bh,
            pixel,
            width,
            height,
            tw,
            th
        ));
        assert_eq!(output, [7; 3]);
    }
}
