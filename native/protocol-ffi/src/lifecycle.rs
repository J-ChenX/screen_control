//! 连接与输出独立拥有内存；租约只保留存活标志，不保留已取消的连接缓冲。
use screen_control_protocol::fragments::{Decoder, Status};
use std::{
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct State {
    decoder: Decoder,
    alive: Arc<AtomicBool>,
}

#[repr(C)]
pub struct Delivery {
    valid: u32,
    opcode: u32,
    prefix: *mut u8,
    prefix_len: u32,
    prefix_capacity: usize,
    prefix_status: u32,
    input_status: u32,
}

impl Default for Delivery {
    fn default() -> Self {
        Self {
            valid: 0,
            opcode: 0,
            prefix: ptr::null_mut(),
            prefix_len: 0,
            prefix_capacity: 0,
            prefix_status: 0,
            input_status: 0,
        }
    }
}

fn status(status: Status) -> u32 {
    match status {
        Status::Complete => 1,
        Status::Partial => 2,
        Status::LastPartial => 3,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_ws_decoder_new(limit: u32) -> *mut State {
    let Ok(decoder) = Decoder::new(limit as usize) else {
        return ptr::null_mut();
    };
    Box::into_raw(Box::new(State {
        decoder,
        alive: Arc::new(AtomicBool::new(true)),
    }))
}

/// # Safety
/// state 是本库创建且尚未释放的对象；仅在连接所属事件线程调用，无并发访问。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_decoder_drop(state: *mut State) {
    if !state.is_null() {
        // 安全依据：C 拥有唯一释放权；先将其字段清空，禁止重入重复释放。
        let state = unsafe { Box::from_raw(state) };
        state.alive.store(false, Ordering::Release);
        drop(state);
    }
}

/// # Safety
/// state 必须有效；返回租约允许跨越同步 C 回调，但必须恰好释放一次。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_decoder_lease(state: *const State) -> *const AtomicBool {
    if state.is_null() {
        return ptr::null();
    }
    // 安全依据：调用期间对象有效；只克隆独立的标志所有权。
    Arc::into_raw(unsafe { &*state }.alive.clone())
}

/// # Safety
/// lease 为尚未释放的租约，即使原 state 已释放仍可读取。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_lease_alive(lease: *const AtomicBool) -> u32 {
    if lease.is_null() {
        return 0;
    }
    // 安全依据：租约保留 Arc 强引用，不访问原 state。
    u32::from(unsafe { &*lease }.load(Ordering::Acquire))
}

/// # Safety
/// lease 是本库返回的租约，不得重复释放或在释放后查询。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_lease_drop(lease: *const AtomicBool) {
    if !lease.is_null() {
        // 安全依据：接回 sc_ws_decoder_lease 转移的一个强引用。
        drop(unsafe { Arc::from_raw(lease) });
    }
}

/// # Safety
/// state 有效且独占；data 在调用期间可读 length 字节。返回后不保留 data 引用。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_decoder_feed(
    state: *mut State,
    opcode: u32,
    fin: u32,
    data: *const u8,
    length: u32,
) -> Delivery {
    if state.is_null()
        || (data.is_null() && length != 0)
        || opcode > 2
        || fin > 1
        || u64::from(length) > screen_control_protocol::MAX_PAYLOAD
    {
        return Delivery::default();
    }
    let input = if length == 0 {
        &[]
    } else {
        // 安全依据：C 已证明输入区间可读，长度受限且不跨越回调。
        unsafe { std::slice::from_raw_parts(data, length as usize) }
    };
    // 安全依据：借用仅存在于此调用，返回前提交状态；不会进入任何 C 回调。
    let Ok(output) = unsafe { &mut *state }
        .decoder
        .feed(opcode as u8, fin != 0, input)
    else {
        return Delivery::default();
    };
    let mut result = Delivery {
        valid: 1,
        opcode: u32::from(output.opcode),
        input_status: output.input.map(status).unwrap_or(0),
        ..Default::default()
    };
    if let Some((bytes, kind)) = output.prefix {
        let mut bytes = std::mem::ManuallyDrop::new(bytes);
        result.prefix = bytes.as_mut_ptr();
        result.prefix_len = bytes.len() as u32;
        result.prefix_capacity = bytes.capacity();
        result.prefix_status = status(kind);
    }
    result
}

/// # Safety
/// delivery 必须是 feed 返回的原始值，所有权只能交还一次。不得将 prefix 交给 C free。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_ws_delivery_drop(delivery: Delivery) {
    if delivery.prefix_status != 0 {
        // 安全依据：还原完整 Vec 元数据，输出不依赖任何 state 的存活。
        drop(unsafe {
            Vec::from_raw_parts(
                delivery.prefix,
                delivery.prefix_len as usize,
                delivery.prefix_capacity,
            )
        });
    }
}
