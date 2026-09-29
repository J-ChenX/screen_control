//! 远控协议安全核心：帧头无分配，分片使用有界所有权，不持有外部指针或回调。
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;
pub mod fragments;
pub mod tile;
pub mod windows_tile;
pub mod ximage;

pub const MAX_PAYLOAD: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub header_len: u32,
    pub payload_len: u32,
    pub fin: bool,
    pub opcode: u8,
    pub mask: Option<[u8; 4]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Header {
    Incomplete,
    Invalid,
    Complete(Frame),
}

/// 解析帧头；正文是否完整由调用方按返回长度单独判断。
/// 不协商扩展，因此拒绝保留位与保留操作码；兼容既有带掩码输入。
pub fn parse_header(bytes: &[u8]) -> Header {
    if bytes.len() < 2 {
        return Header::Incomplete;
    }
    let fin = bytes[0] & 0x80 != 0;
    let opcode = bytes[0] & 0x0f;
    if bytes[0] & 0x70 != 0 || !matches!(opcode, 0 | 1 | 2 | 8 | 9 | 10) {
        return Header::Invalid;
    }
    let control = opcode >= 8;
    let marker = bytes[1] & 0x7f;
    if control && (!fin || marker > 125) {
        return Header::Invalid;
    }
    let (payload_len, mut header_len) = match marker {
        126 => {
            let Some(data) = bytes.get(2..4) else {
                return Header::Incomplete;
            };
            let length = u16::from_be_bytes([data[0], data[1]]) as u64;
            if length < 126 {
                return Header::Invalid;
            }
            (length, 4)
        }
        127 => {
            let Some(data) = bytes.get(2..10) else {
                return Header::Incomplete;
            };
            let mut encoded = [0; 8];
            encoded.copy_from_slice(data);
            let length = u64::from_be_bytes(encoded);
            if length < 65536 {
                return Header::Invalid;
            }
            (length, 10)
        }
        length => (length as u64, 2),
    };
    // 在等待正文或进行任何分配之前拒绝超预算帧，包括最高位和算术溢出输入。
    if payload_len > MAX_PAYLOAD || (opcode == 8 && payload_len == 1) {
        return Header::Invalid;
    }
    let mask = if bytes[1] & 0x80 != 0 {
        let Some(data) = bytes.get(header_len..header_len + 4) else {
            return Header::Incomplete;
        };
        header_len += 4;
        Some([data[0], data[1], data[2], data[3]])
    } else {
        None
    };
    Header::Complete(Frame {
        header_len: header_len as u32,
        payload_len: payload_len as u32,
        fin,
        opcode,
        mask,
    })
}

/// 字节对齐无关的原地掩码；每次传入一个完整帧的正文。
#[inline]
pub fn mask_in_place(bytes: &mut [u8], key: [u8; 4]) {
    let word_key = u32::from_ne_bytes(key);
    let (words, tail) = bytes.as_chunks_mut::<4>();
    for word in words {
        *word = (u32::from_ne_bytes(*word) ^ word_key).to_ne_bytes();
    }
    for (byte, mask) in tail.iter_mut().zip(key) {
        *byte ^= mask;
    }
}

/// 复制同时掩码，避免发送端额外遍历。长度不符时不改变目标。
#[inline]
pub fn mask_copy(destination: &mut [u8], source: &[u8], key: [u8; 4]) -> bool {
    if destination.len() != source.len() {
        return false;
    }
    let word_key = u32::from_ne_bytes(key);
    let (outputs, output_tail) = destination.as_chunks_mut::<4>();
    let (inputs, input_tail) = source.as_chunks::<4>();
    for (output, input) in outputs.iter_mut().zip(inputs) {
        *output = (u32::from_ne_bytes(*input) ^ word_key).to_ne_bytes();
    }
    for ((output, input), mask) in output_tail.iter_mut().zip(input_tail).zip(key) {
        *output = *input ^ mask;
    }
    true
}
