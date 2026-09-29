use screen_control_protocol::tile::{checksum_rgb24_tile, copy_rgb24_tile};

#[test]
fn copies_padded_rows_without_touching_tail() {
    let desktop: Vec<u8> = (0..72).collect();
    let mut target = [0xa5; 16];
    assert!(copy_rgb24_tile(&mut target, &desktop, 8, 2, 0, 2, 2));
    assert_eq!(&target[..12], &[6, 7, 8, 9, 10, 11, 30, 31, 32, 33, 34, 35]);
    assert_eq!(&target[12..], &[0xa5; 4]);
}

#[test]
fn rejects_invalid_regions_without_partial_output() {
    let desktop = [1; 48];
    for (stride, x, y, width, height, length) in [
        (8, 7, 0, 2, 1, 6),
        (8, 0, 1, 2, 2, 12),
        (8, 0, 0, 2, 1, 5),
        (usize::MAX, 0, 0, 2, 1, 6),
        (8, 0, usize::MAX, 2, 2, 12),
    ] {
        let mut target = [0xa5; 12];
        assert!(!copy_rgb24_tile(
            &mut target[..length],
            &desktop,
            stride,
            x,
            y,
            width,
            height
        ));
        assert_eq!(target, [0xa5; 12]);
    }
}

#[test]
fn every_small_tile_matches_source_rows() {
    for stride in 1..=8 {
        let desktop: Vec<u8> = (0..stride * 4 * 3).map(|value| value as u8).collect();
        for x in 0..stride {
            for y in 0..4 {
                for width in 1..=stride - x {
                    for height in 1..=4 - y {
                        let mut target = vec![0xa5; width * height * 3];
                        assert!(copy_rgb24_tile(
                            &mut target,
                            &desktop,
                            stride,
                            x,
                            y,
                            width,
                            height
                        ));
                        for row in 0..height {
                            let start = ((y + row) * stride + x) * 3;
                            assert_eq!(
                                &target[row * width * 3..(row + 1) * width * 3],
                                &desktop[start..start + width * 3]
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn checksum_reads_only_the_requested_tile() {
    let mut desktop: Vec<u8> = (0..48).collect();
    let original = checksum_rgb24_tile(&desktop, 4, 0, 1, 4, 3).unwrap();
    assert_eq!(checksum_rgb24_tile(&desktop[..47], 4, 0, 1, 4, 3), None);
    for index in 12..48 {
        desktop[index] ^= 0x80;
        assert_ne!(checksum_rgb24_tile(&desktop, 4, 0, 1, 4, 3), Some(original));
        desktop[index] ^= 0x80;
    }
    let left = checksum_rgb24_tile(&desktop, 4, 0, 0, 2, 2);
    desktop[6] ^= 0x80;
    assert_eq!(checksum_rgb24_tile(&desktop, 4, 0, 0, 2, 2), left);
}

#[test]
fn checksum_rejects_invalid_and_handles_partial_words() {
    let desktop: Vec<u8> = (0..36).collect();
    for (stride, x, y, width, height) in [
        (3, 0, 0, 0, 1),
        (3, 0, 0, 1, 0),
        (3, 2, 0, 2, 1),
        (3, 0, 3, 1, 2),
        (usize::MAX, 0, 0, 1, 1),
        (3, 0, usize::MAX, 1, 2),
    ] {
        assert_eq!(
            checksum_rgb24_tile(&desktop, stride, x, y, width, height),
            None
        );
    }
    assert!(checksum_rgb24_tile(&desktop, 3, 2, 3, 1, 1).is_some());
    assert_ne!(
        checksum_rgb24_tile(&desktop, 3, 2, 3, 1, 1),
        checksum_rgb24_tile(&desktop, 3, 2, 2, 1, 1)
    );
}
