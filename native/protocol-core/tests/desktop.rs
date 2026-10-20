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
