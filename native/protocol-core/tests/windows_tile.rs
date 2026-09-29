use screen_control_protocol::windows_tile::{checksum_tile, copy_tile};

#[test]
fn bottom_up_copy_and_crc_match_windows_row_order() {
    for pixel_bytes in [3, 4] {
        let stride = 4 * pixel_bytes;
        let source: Vec<u8> = (0..3 * stride).map(|index| index as u8).collect();
        let mut target = vec![0xee; 4 * pixel_bytes];
        assert!(copy_tile(
            &mut target,
            &source,
            4,
            3,
            pixel_bytes,
            1,
            0,
            2,
            2
        ));
        let selected: Vec<u8> = [1, 2]
            .into_iter()
            .flat_map(|row| {
                source[row * stride + pixel_bytes..row * stride + 3 * pixel_bytes].iter()
            })
            .copied()
            .collect();
        assert_eq!(target, selected);
        let expected = [1, 2].into_iter().fold(0u32, |mut checksum, row| {
            let start = row * stride + pixel_bytes;
            for word in source[start..start + 2 * pixel_bytes].as_chunks::<4>().0 {
                checksum = checksum.wrapping_mul(0x0100_0193) ^ u32::from_le_bytes(*word);
            }
            checksum
        });
        assert_eq!(
            checksum_tile(&source, 4, 3, pixel_bytes, 1, 0, 2, 2),
            Some(expected)
        );
    }
}

#[test]
fn invalid_bounds_leave_target_unchanged() {
    let source = vec![3u8; 4 * 3 * 3];
    let mut target = vec![0xa5; 2 * 2 * 3];
    assert!(!copy_tile(&mut target, &source[..30], 4, 3, 3, 1, 0, 2, 2));
    assert!(!copy_tile(&mut target[..4], &source, 4, 3, 3, 1, 0, 2, 2));
    assert!(!copy_tile(&mut target, &source, 4, 3, 3, 3, 0, 2, 2));
    assert!(!copy_tile(&mut target, &source, 4, 3, 2, 1, 0, 2, 2));
    assert_eq!(target, vec![0xa5; 12]);
    assert_eq!(checksum_tile(&source[..30], 4, 3, 3, 1, 0, 2, 2), None);
    assert_eq!(checksum_tile(&source, usize::MAX, 3, 4, 1, 0, 2, 2), None);
}
