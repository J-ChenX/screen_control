/* Linux 桌面独立整帧与四档编码；只复用既有桌面管道，不增加监听或输入能力。 */
#ifndef SC_ADAPTIVE_DESKTOP_H
#define SC_ADAPTIVE_DESKTOP_H
#include <errno.h>
#include <time.h>
#include <sys/random.h>
#include "linux_compression.h"

#define SC_FRAME_METADATA 0x7f00
#define SC_FRAME_ACK 0x7f01
#define SC_FRAME_MOUSE MNG_KVM_MOUSE
#define SC_FRAME_DISCARD 0x7f03
#define SC_FRAME_HISTORY 128
#define SC_ADAPTIVE_JPEG 129
static unsigned int sc_tier = 1440, sc_epoch = 1, sc_sequence = 0, sc_acknowledged = 0;
static unsigned int sc_encoded_width = 0, sc_encoded_height = 0, sc_source_width = 0, sc_source_height = 0;
static unsigned int sc_ack_delay = 0;
static uint64_t sc_feedback_at = 0;
static int sc_epoch_initialized = 0;
static int sc_feedback = 0, sc_force = 1;
static unsigned char *sc_scaled = NULL, *sc_previous = NULL;
static size_t sc_capacity = 0, sc_previous_size = 0;
extern int COMPRESSION_QUALITY;
extern int slave2master[2];
extern unsigned char *jpeg_buffer;
extern int jpeg_buffer_length;

typedef struct { unsigned int epoch, sequence, width, height, source_width, source_height; uint64_t sent_at; } ScSentFrame;
static ScSentFrame sc_sent[SC_FRAME_HISTORY];

static uint64_t sc_now_ms(void)
{
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static void sc_initialize_epoch(void)
{
    if (sc_epoch_initialized) return;
    unsigned int value = 0;
    if (getrandom(&value, sizeof(value), 0) != sizeof(value)) value = (unsigned int)sc_now_ms() ^ ((unsigned int)getpid() << 16);
    sc_epoch = value ? value : 1; sc_epoch_initialized = 1;
}
static void sc_next_epoch(void) { sc_epoch++; if (sc_epoch == 0) sc_epoch = 1; }
static void sc_u16(unsigned char *p, unsigned int value) { p[0] = (unsigned char)(value >> 8); p[1] = (unsigned char)value; }
static void sc_u32(unsigned char *p, unsigned int value) { sc_u16(p, value >> 16); sc_u16(p + 2, value); }
static unsigned int sc_read_u16(const unsigned char *p) { return ((unsigned int)p[0] << 8) | p[1]; }
static unsigned int sc_read_u32(const unsigned char *p) { return ((unsigned int)p[0] << 24) | ((unsigned int)p[1] << 16) | ((unsigned int)p[2] << 8) | p[3]; }
static int sc_write_all(int descriptor, const void *buffer, size_t length)
{
    const unsigned char *p = buffer;
    while (length > 0)
    {
        ssize_t count = write(descriptor, p, length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        p += count; length -= (size_t)count;
    }
    return 1;
}
static ScDesktopSize sc_current_size(void) { return sc_desktop_size((uint32_t)SCREEN_WIDTH, (uint32_t)SCREEN_HEIGHT, sc_tier); }
static void sc_refresh_frame(void) { sc_force = 1; }
static void sc_accept_ack(const unsigned char *packet, int size, int discarded)
{
    if (size != 12) return;
    unsigned int epoch = sc_read_u32(packet + 4), sequence = sc_read_u32(packet + 8);
    ScSentFrame *frame = &sc_sent[sequence % SC_FRAME_HISTORY];
    if (frame->sequence != sequence || frame->epoch != epoch || sequence <= sc_acknowledged || sequence > sc_sequence) return;
    sc_acknowledged = sequence;
    sc_feedback_at = sc_now_ms();
    if (discarded) return;
    uint64_t delay = sc_now_ms() - frame->sent_at;
    sc_ack_delay = delay > 60000 ? 60000 : (unsigned int)delay;
}
static int sc_input_axis(unsigned int value, int vertical)
{
    ScDesktopSize current = sc_current_size();
    unsigned int mapped = sc_desktop_input(value, vertical ? current.height : current.width, vertical ? (unsigned int)SCREEN_HEIGHT : (unsigned int)SCREEN_WIDTH);
    return mapped == UINT32_MAX ? -1 : (int)mapped;
}
static int sc_frame_input_axis(unsigned int epoch, unsigned int sequence, unsigned int value, int vertical)
{
    const ScSentFrame *frame = &sc_sent[sequence % SC_FRAME_HISTORY];
    if (frame->sequence != sequence || frame->epoch != epoch || frame->source_width != (unsigned int)SCREEN_WIDTH || frame->source_height != (unsigned int)SCREEN_HEIGHT) return -1;
    unsigned int mapped = sc_desktop_input(value, vertical ? frame->height : frame->width, vertical ? frame->source_height : frame->source_width);
    return mapped == UINT32_MAX ? -1 : (int)mapped;
}
static int sc_waiting_for_feedback(void)
{
    if (!sc_feedback || sc_sequence - sc_acknowledged < 2) return 0;
    // 共享流中的旧客户端没有展示反馈；最后一个新客户端退出后不能永久饿死旧查看者。
    if (sc_now_ms() - sc_feedback_at >= 2000) { sc_feedback = 0; return 0; }
    return 1;
}
static void sc_release_desktop(void)
{
    free(sc_scaled); free(sc_previous); sc_scaled = sc_previous = NULL;
    sc_capacity = sc_previous_size = 0;
}
static int sc_send_desktop(const unsigned char *source, uint64_t source_length, uint64_t started)
{
    sc_initialize_epoch();
    ScDesktopSize dimensions = sc_current_size();
    if (!dimensions.width || !dimensions.height) return 0;
    size_t required = (size_t)dimensions.width * dimensions.height * 3;
    if (sc_capacity < required)
    {
        unsigned char *scaled = malloc(required), *previous = malloc(required);
        if (scaled == NULL || previous == NULL) { free(scaled); free(previous); return 0; }
        free(sc_scaled); free(sc_previous); sc_scaled = scaled; sc_previous = previous;
        sc_capacity = required; sc_previous_size = 0;
    }
    unsigned int stride = ((unsigned int)SCREEN_WIDTH + TILE_WIDTH - 1) / TILE_WIDTH * TILE_WIDTH;
    if (!sc_desktop_resize(sc_scaled, required, source, source_length, stride, SCREEN_WIDTH, SCREEN_HEIGHT, dimensions.width, dimensions.height)) return 0;
    if (sc_encoded_width != dimensions.width || sc_encoded_height != dimensions.height || sc_source_width != (unsigned int)SCREEN_WIDTH || sc_source_height != (unsigned int)SCREEN_HEIGHT)
    {
        sc_next_epoch(); sc_encoded_width = dimensions.width; sc_encoded_height = dimensions.height;
        sc_source_width = SCREEN_WIDTH; sc_source_height = SCREEN_HEIGHT;
        sc_previous_size = 0; sc_refresh_frame();
        kvm_send_resolution();
    }
    if (!sc_force && sc_previous_size == required && memcmp(sc_scaled, sc_previous, required) == 0) return 1;
    jpeg_buffer_length = 0;
    if (write_JPEG_buffer(sc_scaled, dimensions.width, dimensions.height, COMPRESSION_QUALITY) != 0 || jpeg_buffer == NULL || jpeg_buffer_length <= 0) return 0;
    if (sc_sequence == UINT32_MAX) { sc_sequence = sc_acknowledged = 0; sc_next_epoch(); memset(sc_sent, 0, sizeof(sc_sent)); }
    unsigned int sequence = ++sc_sequence;
    unsigned char metadata[40] = {0}, header[16] = {0};
    sc_u16(metadata, SC_FRAME_METADATA); sc_u16(metadata + 2, sizeof(metadata));
    sc_u16(metadata + 4, 1); sc_u16(metadata + 6, 1 | (sc_feedback ? 2 : 0));
    sc_u32(metadata + 8, sc_epoch); sc_u32(metadata + 12, sequence);
    sc_u16(metadata + 16, SCREEN_WIDTH); sc_u16(metadata + 18, SCREEN_HEIGHT);
    sc_u16(metadata + 20, dimensions.width); sc_u16(metadata + 22, dimensions.height);
    sc_u16(metadata + 24, sc_tier); sc_u16(metadata + 26, COMPRESSION_QUALITY);
    uint64_t processing = sc_now_ms() - started;
    sc_u32(metadata + 28, processing > 60000 ? 60000 : (unsigned int)processing);
    sc_u32(metadata + 32, sc_ack_delay);
    size_t header_size = jpeg_buffer_length > 65500 ? 16 : 8;
    if (header_size == 16)
    {
        sc_u16(header, MNG_JUMBO); sc_u16(header + 2, 8); sc_u32(header + 4, (unsigned int)jpeg_buffer_length + 8);
        sc_u16(header + 8, MNG_KVM_PICTURE);
    }
    else { sc_u16(header, MNG_KVM_PICTURE); sc_u16(header + 2, jpeg_buffer_length + 8); }
    sc_sent[sequence % SC_FRAME_HISTORY] = (ScSentFrame){sc_epoch, sequence, dimensions.width, dimensions.height, (unsigned int)SCREEN_WIDTH, (unsigned int)SCREEN_HEIGHT, sc_now_ms()};
    int success = sc_write_all(slave2master[1], metadata, sizeof(metadata)) && sc_write_all(slave2master[1], header, header_size) && sc_write_all(slave2master[1], jpeg_buffer, (size_t)jpeg_buffer_length);
    if (success) { memcpy(sc_previous, sc_scaled, required); sc_previous_size = required; sc_force = 0; }
    finish_JPEG_tile();
    return success;
}
#endif
