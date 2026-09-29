use screen_control_protocol::fragments::{Decoder, Error, Status};

#[test]
fn large_first_fragment_grows_to_required_size() {
    let mut state = Decoder::new(65536).unwrap();
    let first = vec![7; 10000];
    assert!(state.feed(2, false, &first).unwrap().prefix.is_none());
    let out = state.feed(0, true, &[8; 3]).unwrap();
    let (bytes, status) = out.prefix.unwrap();
    assert_eq!(status, Status::Complete);
    assert_eq!(&bytes[..10000], first);
    assert_eq!(&bytes[10000..], &[8; 3]);
    assert_eq!(state.retained_capacity(), 0);
    drop(state);
    assert_eq!(bytes.len(), 10003); // 输出在连接销毁后仍然有效。
}

#[test]
fn limit_switches_to_streaming_without_losing_bytes() {
    for limit in [0, 1, 17, 4096, 65536] {
        let mut state = Decoder::new(limit).unwrap();
        let chunks = [vec![1; 5000], vec![2; 9000], vec![3; 7]];
        let mut actual = Vec::new();
        let mut statuses = Vec::new();
        for (i, bytes) in chunks.iter().enumerate() {
            let out = state
                .feed(if i == 0 { 2 } else { 0 }, i == 2, bytes)
                .unwrap();
            assert_eq!(out.opcode, 2);
            if let Some((prefix, status)) = out.prefix {
                actual.extend(prefix);
                statuses.push(status);
            }
            if let Some(status) = out.input {
                actual.extend(bytes);
                statuses.push(status);
            }
            assert!(state.retained_capacity() <= limit);
        }
        assert_eq!(actual, chunks.concat());
        assert_eq!(
            statuses.last(),
            Some(if limit < 14007 {
                &Status::LastPartial
            } else {
                &Status::Complete
            })
        );
        assert_eq!(state.retained_capacity(), 0);
    }
}

#[test]
fn sequence_rejects_orphan_continuation_and_nested_start() {
    let mut state = Decoder::new(1024).unwrap();
    assert_eq!(
        state.feed(0, true, &[]).unwrap_err(),
        Error::InvalidSequence
    );
    state.feed(1, false, &[]).unwrap();
    assert_eq!(
        state.feed(2, false, &[]).unwrap_err(),
        Error::InvalidSequence
    );
    assert_eq!(
        state.feed(9, true, &[]).unwrap_err(),
        Error::InvalidSequence
    );
    assert_eq!(state.feed(0, true, &[]).unwrap().opcode, 1);
    assert_eq!(
        state.feed(2, true, &[1]).unwrap().input,
        Some(Status::Complete)
    );
}

#[test]
fn complete_messages_do_not_allocate_and_peak_is_not_retained() {
    let mut state = Decoder::new(65536).unwrap();
    for _ in 0..1000 {
        assert!(state.feed(2, true, &[1; 100]).unwrap().prefix.is_none());
        assert_eq!(state.retained_capacity(), 0);
        state.feed(2, false, &[2; 4096]).unwrap();
        let out = state.feed(0, true, &[3; 4096]).unwrap();
        assert_eq!(out.prefix.unwrap().0.len(), 8192);
        assert_eq!(state.retained_capacity(), 0);
    }
}

#[test]
fn empty_fragmented_message_returns_independent_empty_prefix() {
    let mut state = Decoder::new(65536).unwrap();
    let first = state.feed(2, false, &[]).unwrap();
    assert!(first.prefix.is_none());
    assert!(first.input.is_none());
    let last = state.feed(0, true, &[]).unwrap();
    let (prefix, status) = last.prefix.unwrap();
    assert!(prefix.is_empty());
    assert_eq!(status, Status::Complete);
    assert_eq!(state.retained_capacity(), 0);
}
