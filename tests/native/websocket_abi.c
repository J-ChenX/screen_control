#include "screen_control_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

_Static_assert(sizeof(ScWsHeader) == 16, "帧头 ABI 大小不一致");
_Static_assert(sizeof(ScWsFrame) == 20, "解析结果 ABI 大小不一致");
_Static_assert(sizeof(ScXImageMeta) == 56, "图像元数据 ABI 大小不一致");
_Static_assert(sizeof(ScCursorMeta) == 32, "光标元数据 ABI 大小不一致");

/* 即使以 -DNDEBUG 构建也必须实际执行 ABI 调用与结果检查。 */
#define CHECK(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "C ABI 检查失败：%d：%s\n", __LINE__, #expression); \
        return 1; \
    } \
} while (0)

int main(void)
{
    unsigned char ximage_input[16] = {3, 2, 1, 6, 5, 4, 0xee, 0xee,
                                      9, 8, 7, 12, 11, 10, 0xee, 0xee};
    unsigned char ximage_output[48];
    memset(ximage_output, 0xa5, sizeof(ximage_output));
    ScXImageMeta image_meta = {2, 2, 8, 4, 4, 24, 0, 0, 0xff0000, 0xff00, 0xff};
    CHECK(sc_ximage_rgb24(ximage_output, sizeof(ximage_output), ximage_input,
                           sizeof(ximage_input), image_meta) == 1);
    CHECK(memcmp(ximage_output, (unsigned char[]){1, 2, 3, 4, 5, 6}, 6) == 0);
    image_meta.source_stride = 5;
    memset(ximage_output, 0xa5, sizeof(ximage_output));
    CHECK(sc_ximage_rgb24(ximage_output, sizeof(ximage_output), ximage_input,
                           sizeof(ximage_input), image_meta) == 0);
    CHECK(ximage_output[0] == 0xa5);
    unsigned long cursor_pixel = 0xff000000ul;
    ScCursorMeta cursor_meta = {4, 2, 2, 1, 1, sizeof(unsigned long), 0, 0};
    memset(ximage_output, 10, sizeof(ximage_output));
    CHECK(sc_cursor_overlay_rgb24(ximage_output, sizeof(ximage_output),
                                   (unsigned char *)&cursor_pixel, sizeof(cursor_pixel), cursor_meta) == 1);
    CHECK(ximage_output[0] == 245 && ximage_output[1] == 245 && ximage_output[2] == 245);
    CHECK(sc_cursor_overlay_rgb24(ximage_output, sizeof(ximage_output),
                                   (unsigned char *)&cursor_pixel, sizeof(cursor_pixel) - 1, cursor_meta) == 0);
    unsigned char desktop[72];
    unsigned char tile[16];
    for (unsigned int i = 0; i < sizeof(desktop); ++i) desktop[i] = (unsigned char)i;
    memset(tile, 0xa5, sizeof(tile));
    CHECK(sc_tile_copy_rgb24(tile, sizeof(tile), desktop, sizeof(desktop), 7, 4, 2, 0, 2, 2) == 1);
    CHECK(memcmp(tile, desktop + 6, 6) == 0);
    CHECK(memcmp(tile + 6, desktop + 30, 6) == 0);
    CHECK(tile[12] == 0xa5);
    memset(tile, 0xa5, sizeof(tile));
    CHECK(sc_tile_copy_rgb24(tile, sizeof(tile), desktop, 30, 7, 4, 2, 0, 2, 2) == 0);
    CHECK(tile[0] == 0xa5);
    CHECK(sc_tile_copy_rgb24(tile, sizeof(tile), tile, sizeof(tile), 7, 4, 0, 0, 2, 1) == 0);
    CHECK(sc_tile_copy_rgb24(tile, sizeof(tile), desktop, sizeof(desktop), -1, 4, 0, 0, 2, 1) == 0);
    uint32_t checksum = 0xa5a5a5a5;
    CHECK(sc_tile_crc_rgb24(desktop, sizeof(desktop), 7, 4, 4, 2, 4, 1, &checksum) == 1);
    uint32_t original_checksum = checksum;
    desktop[71] ^= 0x80;
    CHECK(sc_tile_crc_rgb24(desktop, sizeof(desktop), 7, 4, 4, 2, 4, 1, &checksum) == 1);
    CHECK(checksum != original_checksum);
    desktop[71] ^= 0x80;
    checksum = 0xa5a5a5a5;
    CHECK(sc_tile_crc_rgb24(desktop, sizeof(desktop) - 1, 7, 4, 4, 2, 4, 1, &checksum) == 0);
    CHECK(checksum == 0xa5a5a5a5);
    CHECK(sc_tile_crc_rgb24(desktop, sizeof(desktop), 7, 4, 4, 2, 4, 1, (uint32_t *)(desktop + 64)) == 0);
    CHECK(sc_tile_crc_rgb24(desktop, sizeof(desktop), 7, 4, 4, 2, 4, 1, (uint32_t *)(desktop + 1)) == 0);
    ScWsHeader header = {{0x82, 0x7f, 0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff}, 10, 0};
    CHECK(sc_ws_parse(header, 10).status == 2);
    header.bytes[1] = 0;
    header.count = 2;
    CHECK(sc_ws_parse(header, 2).status == 1);
    header.bytes[1] = 125;
    CHECK(sc_ws_parse(header, 126).status == 0);
    CHECK(sc_ws_parse(header, 127).payload_len == 125);
    header.count = 15;
    CHECK(sc_ws_parse(header, 127).status == 2);
    header.count = 2;
    CHECK(sc_ws_parse(header, 1).status == 2);
    header.reserved = 1;
    CHECK(sc_ws_parse(header, 127).status == 2);
    header = (ScWsHeader){{0xc2, 0x03}, 2, 0};
    CHECK(sc_ws_parse(header, 5).status == 2);
    CHECK(sc_ws_parse_extensions(header, 5, 0).status == 2);
    ScWsFrame compressed = sc_ws_parse_extensions(header, 5, 1);
    CHECK(compressed.status == 1 && compressed.payload_len == 3 && (compressed.flags & 0x200));
    header.bytes[0] = 0xc0;
    CHECK(sc_ws_parse_extensions(header, 5, 1).status == 2);
    header.bytes[0] = 0xc9;
    CHECK(sc_ws_parse_extensions(header, 5, 1).status == 2);
    header.bytes[0] = 0xe2;
    CHECK(sc_ws_parse_extensions(header, 5, 1).status == 2);
    header.bytes[0] = 0xc2;
    CHECK(sc_ws_parse_extensions(header, 5, 2).status == 2);
    const unsigned char key[] = {0x78, 0x56, 0x34, 0x12};
    for (unsigned int length = 0; length < 4097; ++length) {
        /* 分配精确长度加起点偏移，让 ASan 能看见末端越界。 */
        for (unsigned int offset = 0; offset < 8; ++offset) {
            unsigned char *a = malloc(length + offset + 1);
            unsigned char *b = malloc(length + offset + 1);
            CHECK(a && b);
            memset(a, 0xa5, length + offset + 1);
            memset(b, 0x5a, length + offset + 1);
            CHECK(sc_ws_mask_copy(b + offset, a + offset, length, 0x12345678) == 1);
            for (unsigned int i = 0; i < length; ++i) CHECK(b[offset + i] == (0xa5 ^ key[i % 4]));
            CHECK(b[offset + length] == 0x5a);
            if (offset) CHECK(b[offset - 1] == 0x5a);
            CHECK(sc_ws_mask(b + offset, length, 0x12345678) == 1);
            for (unsigned int i = 0; i < length; ++i) CHECK(b[offset + i] == 0xa5);
            if (length) CHECK(sc_ws_mask_copy(a + offset, a + offset, length, 0) == 0);
            free(a); free(b);
        }
    }
    CHECK(sc_ws_mask(NULL, 0, 0) == 1);
    CHECK(sc_ws_mask(NULL, 1, 0) == 0);
    CHECK(sc_ws_mask_copy(NULL, NULL, 0, 0) == 1);
    CHECK(sc_ws_decoder_new(UINT32_MAX) == NULL);
    for (int round = 0; round < 1000; round++) {
        ScWsDecoder *state = sc_ws_decoder_new(65536);
        const ScWsLease *lease = sc_ws_decoder_lease(state);
        CHECK(state && sc_ws_lease_alive(lease));
        unsigned char input[10000]; memset(input, 7, sizeof(input));
        ScWsDelivery pending = sc_ws_decoder_feed(state, 2, 0, input, sizeof(input));
        CHECK(pending.valid && pending.prefix_status == 0 && pending.input_status == 0);
        sc_ws_delivery_drop(pending);
        ScWsDelivery result = sc_ws_decoder_feed(state, 0, 1, input, sizeof(input));
        CHECK(result.valid && result.opcode == 2 && result.prefix_len == 20000 && result.prefix_status == 1);
        sc_ws_decoder_drop(state);
        CHECK(!sc_ws_lease_alive(lease));
        for (unsigned int i = 0; i < result.prefix_len; i++) CHECK(result.prefix[i] == 7);
        sc_ws_delivery_drop(result);
        sc_ws_lease_drop(lease);
    }
    for (int round = 0; round < 1000; round++) {
        ScWsDecoder *state = sc_ws_decoder_new(65536);
        CHECK(state);
        ScWsDelivery first = sc_ws_decoder_feed(state, 2, 0, NULL, 0);
        CHECK(first.valid && first.prefix_status == 0 && first.input_status == 0);
        sc_ws_delivery_drop(first);
        ScWsDelivery last = sc_ws_decoder_feed(state, 0, 1, NULL, 0);
        CHECK(last.valid && last.prefix_status == 1 && last.prefix_len == 0 && last.prefix != NULL);
        sc_ws_decoder_drop(state);
        sc_ws_delivery_drop(last);
    }
    {
        /* 非法帧不能改变正在重组的消息；后续合法 continuation 仍可完成。 */
        unsigned char input[] = {0x31, 0x32};
        ScWsDecoder *state = sc_ws_decoder_new(8);
        CHECK(state);
        ScWsDelivery orphan = sc_ws_decoder_feed(state, 0, 1, input, 1);
        CHECK(!orphan.valid);
        sc_ws_delivery_drop(orphan);
        ScWsDelivery first = sc_ws_decoder_feed(state, 2, 0, input, 1);
        CHECK(first.valid && first.opcode == 2 && !first.prefix_status && !first.input_status);
        sc_ws_delivery_drop(first);
        ScWsDelivery invalid = sc_ws_decoder_feed(state, 1, 1, input, 1);
        CHECK(!invalid.valid);
        sc_ws_delivery_drop(invalid);
        ScWsDelivery last = sc_ws_decoder_feed(state, 0, 1, input + 1, 1);
        CHECK(last.valid && last.opcode == 2 && last.prefix_status == 1);
        CHECK(last.prefix_len == sizeof(input) && !last.input_status);
        sc_ws_decoder_drop(state);
        CHECK(memcmp(last.prefix, input, sizeof(input)) == 0);
        sc_ws_delivery_drop(last);
    }
    {
        /* 达到预算后的前缀归 Rust 输出所有；当前输入仍由调用方交付。 */
        unsigned char prefix_input[] = {0x41, 0x42, 0x43};
        unsigned char final_input[] = {0x44, 0x45, 0x46};
        ScWsDecoder *state = sc_ws_decoder_new(4);
        CHECK(state);
        ScWsDelivery first = sc_ws_decoder_feed(state, 2, 0, prefix_input, sizeof(prefix_input));
        CHECK(first.valid && !first.prefix_status && !first.input_status);
        sc_ws_delivery_drop(first);
        ScWsDelivery streamed = sc_ws_decoder_feed(state, 0, 1, final_input, sizeof(final_input));
        CHECK(streamed.valid && streamed.opcode == 2);
        CHECK(streamed.prefix_status == 2 && streamed.prefix_len == sizeof(prefix_input));
        CHECK(streamed.input_status == 3 && streamed.prefix != NULL);
        sc_ws_decoder_drop(state);
        CHECK(memcmp(streamed.prefix, prefix_input, sizeof(prefix_input)) == 0);
        CHECK(memcmp(final_input, (unsigned char[]){0x44, 0x45, 0x46}, sizeof(final_input)) == 0);
        sc_ws_delivery_drop(streamed);
    }
    {
        /* 多个租约各自存活；状态销毁只改变 alive，不提前释放租约。 */
        ScWsDecoder *state = sc_ws_decoder_new(8);
        CHECK(state);
        const ScWsLease *first = sc_ws_decoder_lease(state);
        const ScWsLease *second = sc_ws_decoder_lease(state);
        CHECK(first && second);
        CHECK(sc_ws_lease_alive(first) && sc_ws_lease_alive(second));
        sc_ws_decoder_drop(state);
        CHECK(!sc_ws_lease_alive(first) && !sc_ws_lease_alive(second));
        sc_ws_lease_drop(second);
        sc_ws_lease_drop(first);
        state = sc_ws_decoder_new(8);
        CHECK(state);
        first = sc_ws_decoder_lease(state);
        CHECK(first && sc_ws_lease_alive(first));
        sc_ws_lease_drop(first);
        sc_ws_decoder_drop(state);
    }
    {
        /* Windows 位图是底向上行序；短输入和重叠输出均不得写入目标。 */
        for (int pixel = 3; pixel <= 4; pixel++) {
            unsigned char source[48], target[16];
            for (int i = 0; i < 48; i++) source[i] = (unsigned char)i;
            memset(target, 0xa5, sizeof(target));
            CHECK(sc_win_tile_copy(target, sizeof(target), source, (uint64_t)(3 * 4 * pixel),
                                   4, 3, pixel, 1, 0, 2, 2) == 1);
            for (int row = 0; row < 2; row++) {
                CHECK(memcmp(target + row * 2 * pixel,
                             source + (row + 1) * 4 * pixel + pixel, 2 * pixel) == 0);
            }
            uint32_t checksum = 0;
            CHECK(sc_win_tile_crc(source, (uint64_t)(3 * 4 * pixel), 4, 3, pixel,
                                  1, 0, 2, 2, &checksum) == 1);
            uint32_t expected = 0;
            for (int row = 1; row <= 2; row++) {
                const unsigned char *slice = source + row * 4 * pixel + pixel;
                for (int offset = 0; offset + 4 <= 2 * pixel; offset += 4) {
                    uint32_t word = (uint32_t)slice[offset] | ((uint32_t)slice[offset + 1] << 8) |
                                    ((uint32_t)slice[offset + 2] << 16) | ((uint32_t)slice[offset + 3] << 24);
                    expected = expected * UINT32_C(0x01000193) ^ word;
                }
            }
            CHECK(checksum == expected);
            memset(target, 0xa5, sizeof(target));
            CHECK(sc_win_tile_copy(target, sizeof(target), source, 30,
                                   4, 3, pixel, 1, 0, 2, 2) == 0);
            CHECK(target[0] == 0xa5);
            CHECK(sc_win_tile_copy(source, sizeof(source), source, sizeof(source),
                                   4, 3, pixel, 1, 0, 2, 2) == 0);
            checksum = 0xa5a5a5a5;
            CHECK(sc_win_tile_crc(source, 30, 4, 3, pixel, 1, 0, 2, 2, &checksum) == 0);
            CHECK(checksum == 0xa5a5a5a5);
        }
    }
    puts("C ABI 布局、掩码、分片、Windows 图块边界与多租约通过");
    return 0;
}
