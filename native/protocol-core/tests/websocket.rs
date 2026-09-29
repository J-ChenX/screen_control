use screen_control_protocol::{Frame, Header, MAX_PAYLOAD, mask_copy, mask_in_place, parse_header};

fn header(length: u64, masked: bool) -> ([u8; 14], usize) {
    let mut data = [0; 14];
    data[0] = 0x82;
    let count = if length < 126 {
        data[1] = length as u8;
        2
    } else if length < 65536 {
        data[1] = 126;
        data[2..4].copy_from_slice(&(length as u16).to_be_bytes());
        4
    } else {
        data[1] = 127;
        data[2..10].copy_from_slice(&length.to_be_bytes());
        10
    };
    if masked {
        data[1] |= 0x80;
        data[count..count + 4].copy_from_slice(&[7, 0, 255, 31]);
    }
    (data, count + if masked { 4 } else { 0 })
}

#[test]
fn every_header_truncation_and_length_boundary() {
    for length in [0, 1, 125, 126, 127, 65535, 65536, MAX_PAYLOAD] {
        for masked in [false, true] {
            let (data, count) = header(length, masked);
            for cutoff in 0..count {
                assert_eq!(parse_header(&data[..cutoff]), Header::Incomplete);
            }
            assert_eq!(
                parse_header(&data[..count]),
                Header::Complete(Frame {
                    header_len: count as u32,
                    payload_len: length as u32,
                    fin: true,
                    opcode: 2,
                    mask: masked.then_some([7, 0, 255, 31]),
                })
            );
        }
    }
}

#[test]
fn reject_large_frames_before_body_or_mask_arrives() {
    for length in [
        MAX_PAYLOAD + 1,
        i32::MAX as u64,
        u32::MAX as u64,
        1 << 63,
        u64::MAX,
    ] {
        let (data, _) = header(length, true);
        assert_eq!(parse_header(&data[..10]), Header::Invalid);
    }
}

#[test]
fn control_opcode_reserved_bits_and_canonical_lengths() {
    for opcode in 0..16 {
        let accepted = matches!(opcode, 0 | 1 | 2 | 8 | 9 | 10);
        assert_eq!(
            matches!(parse_header(&[0x80 | opcode, 0]), Header::Complete(_)),
            accepted
        );
    }
    for first in [0xc2, 0xa2, 0x92, 0x08, 0x09, 0x0a] {
        assert_eq!(parse_header(&[first, 0]), Header::Invalid);
    }
    for bytes in [
        &[0x89, 126][..],
        &[0x88, 1],
        &[0x82, 126, 0, 125],
        &[0x82, 127, 0, 0, 0, 0, 0, 0, 255, 255],
    ] {
        assert_eq!(parse_header(bytes), Header::Invalid);
    }
    assert!(matches!(parse_header(&[0x89, 125]), Header::Complete(_)));
    assert!(matches!(
        parse_header(&[0x02, 126, 0, 126]),
        Header::Complete(_)
    ));
}

#[test]
fn arbitrary_headers_never_exceed_budget_or_supplied_header() {
    let mut random = 0xcafef00du64;
    for _ in 0..50_000 {
        let mut data = [0; 14];
        for byte in &mut data {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            *byte = random as u8;
        }
        for size in 0..=14 {
            if let Header::Complete(frame) = parse_header(&data[..size]) {
                assert!(frame.header_len as usize <= size);
                assert!(u64::from(frame.payload_len) <= MAX_PAYLOAD);
                assert!(frame.header_len.checked_add(frame.payload_len).unwrap() < i32::MAX as u32);
            }
        }
    }
}

#[test]
fn mask_matches_reference_on_unaligned_ranges_and_round_trips() {
    let key = [0x17, 0x89, 0xab, 0xff];
    for length in (0..=513).chain([4095, 4096, 65536]) {
        for offset in 0..16 {
            let mut data: Vec<u8> = (0..length + 32).map(|i| i as u8).collect();
            let original = data.clone();
            mask_in_place(&mut data[offset..offset + length], key);
            for i in 0..length {
                assert_eq!(data[offset + i], original[offset + i] ^ key[i & 3]);
            }
            assert_eq!(&data[..offset], &original[..offset]);
            assert_eq!(&data[offset + length..], &original[offset + length..]);
            let mut output = vec![0; length];
            assert!(mask_copy(
                &mut output,
                &original[offset..offset + length],
                key
            ));
            assert_eq!(output, data[offset..offset + length]);
            mask_in_place(&mut data[offset..offset + length], key);
            assert_eq!(data, original);
        }
    }
}

#[test]
fn mismatched_destination_remains_unchanged() {
    let mut output = [42; 3];
    assert!(!mask_copy(&mut output, &[1, 2], [1; 4]));
    assert_eq!(output, [42; 3]);
}
