//! 有界分片重组；超出重组预算后沿用流式交付，输出所有权与连接状态分离。
use alloc::vec::Vec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Complete,
    Partial,
    LastPartial,
}

#[derive(Debug)]
pub struct Delivery {
    pub opcode: u8,
    pub prefix: Option<(Vec<u8>, Status)>,
    pub input: Option<Status>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidSequence,
    Budget,
    Allocation,
}

pub struct Decoder {
    limit: usize,
    active: Option<u8>,
    streaming: bool,
    buffer: Vec<u8>,
}

impl Decoder {
    pub fn new(limit: usize) -> Result<Self, Error> {
        if limit > crate::MAX_PAYLOAD as usize {
            return Err(Error::Budget);
        }
        Ok(Self {
            limit,
            active: None,
            streaming: false,
            buffer: Vec::new(),
        })
    }

    /// 输入已通过帧头检查的一个完整数据帧。调用结束前提交状态；输出不借用自身。
    /// input 指示调用方交付原输入，避免完整消息及流式消息的额外拷贝。
    pub fn feed(&mut self, opcode: u8, fin: bool, input: &[u8]) -> Result<Delivery, Error> {
        let message_type = match (opcode, self.active) {
            (0, Some(kind)) => kind,
            (1 | 2, None) => opcode,
            _ => return Err(Error::InvalidSequence),
        };
        if input.len() > crate::MAX_PAYLOAD as usize {
            return Err(Error::Budget);
        }
        let mut out = Delivery {
            opcode: message_type,
            prefix: None,
            input: None,
        };
        if self.limit == 0 || self.streaming {
            out.input = Some(if fin {
                Status::LastPartial
            } else {
                Status::Partial
            });
        } else if self.active.is_none() && fin {
            out.input = Some(Status::Complete);
        } else {
            let total = self
                .buffer
                .len()
                .checked_add(input.len())
                .ok_or(Error::Budget)?;
            if total > self.limit {
                if !self.buffer.is_empty() {
                    out.prefix = Some((core::mem::take(&mut self.buffer), Status::Partial));
                }
                out.input = Some(if fin {
                    Status::LastPartial
                } else {
                    Status::Partial
                });
                self.streaming = true;
            } else {
                if total > self.buffer.capacity() {
                    // 最后一个分片后立即交付，不再为后续增长预留翻倍容量。
                    let capacity = if fin {
                        total
                    } else {
                        total.max(self.buffer.capacity().saturating_mul(2).min(self.limit))
                    };
                    self.buffer
                        .try_reserve_exact(capacity - self.buffer.len())
                        .map_err(|_| Error::Allocation)?;
                }
                self.buffer.extend_from_slice(input);
                if fin {
                    out.prefix = Some((core::mem::take(&mut self.buffer), Status::Complete));
                }
            }
        }
        self.active = if fin { None } else { Some(message_type) };
        if fin {
            self.streaming = false;
        }
        Ok(out)
    }

    /// 当前连接保留的容量；输出由消费方独立释放，不属于连接的驻留量。
    pub fn retained_capacity(&self) -> usize {
        self.buffer.capacity()
    }
}
