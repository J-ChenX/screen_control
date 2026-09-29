#ifndef SCREEN_CONTROL_PROTOCOL_H
#define SCREEN_CONTROL_PROTOCOL_H
#include <stdint.h>
#include <stddef.h>

/* 按值传递帧头，避免解析器借用 C 缓冲；字段布局与 Rust repr(C) 一致。 */
typedef struct { uint8_t bytes[14]; uint8_t count; uint8_t reserved; } ScWsHeader;
typedef struct {
    uint32_t status;
    uint32_t header_len;
    uint32_t payload_len;
    uint32_t flags;
    uint32_t mask;
} ScWsFrame;

ScWsFrame sc_ws_parse(ScWsHeader header, uint32_t available);
/* 仅在已协商 permessage-deflate 的数据首帧允许 RSV1。 */
ScWsFrame sc_ws_parse_extensions(ScWsHeader header, uint32_t available, uint32_t deflate);
/* length 非零时数据必须有效；原地接口要求独占，复制接口拒绝重叠。 */
uint32_t sc_ws_mask(uint8_t *data, uint32_t length, uint32_t key);
uint32_t sc_ws_mask_copy(uint8_t *destination, const uint8_t *source, uint32_t length, uint32_t key);
/* 校验 RGB24 tile 的全部行与目标容量；两个区域必须有效且不重叠。 */
uint32_t sc_tile_copy_rgb24(uint8_t *destination, uint64_t destination_len,
                            const uint8_t *desktop, uint64_t desktop_len,
                            int32_t screen_width, int32_t tile_width,
                            int32_t x, int32_t y, int32_t width, int32_t height);
/* 只读取 tile 内字节；checksum 必须对齐、可写，且不与桌面帧重叠。 */
uint32_t sc_tile_crc_rgb24(const uint8_t *desktop, uint64_t desktop_len,
                           int32_t screen_width, int32_t tile_width,
                           int32_t x, int32_t y, int32_t width, int32_t height,
                           uint32_t *checksum);
/* Windows 底向上位图；校验 24/32 位像素、坐标和实际捕获长度。 */
uint32_t sc_win_tile_copy(uint8_t *destination, uint64_t destination_len,
                          const uint8_t *desktop, uint64_t desktop_len,
                          int32_t screen_width, int32_t screen_height, int32_t pixel_bytes,
                          int32_t x, int32_t y, int32_t width, int32_t height);
uint32_t sc_win_tile_crc(const uint8_t *desktop, uint64_t desktop_len,
                         int32_t screen_width, int32_t screen_height, int32_t pixel_bytes,
                         int32_t x, int32_t y, int32_t width, int32_t height,
                         uint32_t *checksum);
typedef struct {
    uint32_t width, height, source_stride, output_stride, output_height;
    uint32_t bits_per_pixel, byte_order, reserved;
    uint64_t red_mask, green_mask, blue_mask;
} ScXImageMeta;
/* XShm 图像和桌面缓冲必须有效且不重叠；本调用不保存指针。 */
uint32_t sc_ximage_rgb24(uint8_t *destination, uint64_t destination_len,
                         const uint8_t *source, uint64_t source_len, ScXImageMeta meta);
typedef struct {
    uint32_t stride_pixels, width, height, cursor_width, cursor_height, pixel_bytes;
    int32_t origin_x, origin_y;
} ScCursorMeta;
/* XFixes ARGB 像素作为同步借用；目标是已转换的 RGB24 桌面帧。 */
uint32_t sc_cursor_overlay_rgb24(uint8_t *destination, uint64_t destination_len,
                                 const uint8_t *cursor, uint64_t cursor_len, ScCursorMeta meta);

/* 所有连接方法在所属事件线程调用；禁止持有 Rust 借用进入 C 回调。 */
typedef struct ScWsDecoder ScWsDecoder;
typedef struct ScWsLease ScWsLease;
typedef struct {
    uint32_t valid, opcode;
    uint8_t *prefix;
    uint32_t prefix_len;
    size_t prefix_capacity;
    uint32_t prefix_status, input_status; /* 0 无输出、1 完整、2 中间、3 最后分片 */
} ScWsDelivery;
ScWsDecoder *sc_ws_decoder_new(uint32_t limit);
void sc_ws_decoder_drop(ScWsDecoder *state);
const ScWsLease *sc_ws_decoder_lease(const ScWsDecoder *state);
uint32_t sc_ws_lease_alive(const ScWsLease *lease);
void sc_ws_lease_drop(const ScWsLease *lease);
ScWsDelivery sc_ws_decoder_feed(ScWsDecoder *state, uint32_t opcode, uint32_t fin, const uint8_t *data, uint32_t length);
/* 仅交回一次原始返回值；prefix 不能用 free 释放。状态销毁不使输出失效。 */
void sc_ws_delivery_drop(ScWsDelivery delivery);
#endif
