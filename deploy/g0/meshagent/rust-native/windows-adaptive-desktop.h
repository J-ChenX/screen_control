/* Windows GDI／GDI+／既有写回调适配；所有协议状态仅在采集线程修改。 */
#ifndef SC_WINDOWS_ADAPTIVE_DESKTOP_H
#define SC_WINDOWS_ADAPTIVE_DESKTOP_H
#include <limits.h>
#include "microstack/screen_control_protocol.h"
static int COMPRESSION_QUALITY = 90;
static ILibKVM_WriteHandler sc_writer;
static void *sc_writer_reserved;
static unsigned char *sc_jpeg = NULL;
int sc_windows_encode(const unsigned char *, unsigned int, unsigned int, int, unsigned char **, size_t *);
static uint64_t sc_now_ms(void) { return GetTickCount64(); }
static unsigned int sc_platform_epoch(void)
{
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return (unsigned int)counter.LowPart ^ (unsigned int)counter.HighPart ^ (GetCurrentProcessId() << 16);
}
static int sc_platform_write(const void *buffer, size_t length)
{
    if (!sc_writer || length > INT_MAX) return 0;
    ILibTransport_DoneState state = sc_writer((char *)buffer, (int)length, sc_writer_reserved);
    if (state == ILibTransport_DoneState_INCOMPLETE) g_pause = 1;
    return state != ILibTransport_DoneState_ERROR;
}
static int sc_platform_resize(unsigned char *destination, size_t length, const unsigned char *source, uint64_t source_length, ScDesktopSize size)
{
    if (SCREEN_WIDTH <= 0 || SCREEN_HEIGHT <= 0 || SCREEN_WIDTH > 65535 || SCREEN_HEIGHT > 65535 || TILE_WIDTH <= 0 || (PIXEL_SIZE != 3 && PIXEL_SIZE != 4)) return 0;
    unsigned int stride = ((unsigned int)SCREEN_WIDTH + TILE_WIDTH - 1) / TILE_WIDTH * TILE_WIDTH * PIXEL_SIZE;
    unsigned int bitmap_height = ((unsigned int)SCREEN_HEIGHT + TILE_WIDTH - 1) / TILE_WIDTH * TILE_WIDTH;
    return sc_desktop_resize_windows(destination, length, source, source_length, stride, bitmap_height, PIXEL_SIZE, SCREEN_WIDTH, SCREEN_HEIGHT, size.width, size.height);
}
static int sc_platform_encode(const unsigned char *source, unsigned int width, unsigned int height, int quality, unsigned char **output, size_t *length)
{
    /* 上次 JPEG 已同步写出；编码器返回新分配，不能覆盖仍持有的指针。 */
    free(sc_jpeg); sc_jpeg = NULL;
    if (!sc_windows_encode(source, width, height, quality, &sc_jpeg, length)) return 0;
    *output = sc_jpeg; return 1;
}
static void sc_platform_finish(void) { free(sc_jpeg); sc_jpeg = NULL; }
static void sc_platform_resolution(void);
#include "sc_adaptive_desktop_core.h"
static void sc_platform_resolution(void)
{
    ScDesktopSize size = sc_current_size();
    unsigned char packet[8] = {0};
    sc_u16(packet, MNG_KVM_SCREEN); sc_u16(packet + 2, 8);
    sc_u16(packet + 4, size.width); sc_u16(packet + 6, size.height);
    if (!sc_platform_write(packet, sizeof(packet))) g_shutdown = 1;
}

/* 输入线程只复制字节；采集线程消费命令，发送时不持有队列锁。 */
#define SC_CONTROL_CAPACITY 65536
static SRWLOCK sc_control_lock = SRWLOCK_INIT;
static unsigned char sc_control_queue[SC_CONTROL_CAPACITY];
static size_t sc_control_length = 0;
static unsigned char sc_control_partial[SC_CONTROL_CAPACITY];
static size_t sc_control_used = 0;
static int sc_queue_input(const char *data, int length)
{
    int success = 0;
    AcquireSRWLockExclusive(&sc_control_lock);
    if (length >= 0 && (size_t)length <= sizeof(sc_control_queue) - sc_control_length)
    {
        memcpy(sc_control_queue + sc_control_length, data, (size_t)length);
        sc_control_length += (size_t)length; success = 1;
    }
    ReleaseSRWLockExclusive(&sc_control_lock);
    if (!success) g_shutdown = 1;
    return success ? length : 0;
}
/* 有界地耗尽已入队数据；仍有完整消息时不进入反馈超时或新采集。 */
static int sc_drain_input(void)
{
    for (unsigned int pass = 0; pass < 4 && !g_shutdown; pass++)
    {
        AcquireSRWLockExclusive(&sc_control_lock);
        size_t count = sc_control_length;
        if (count > sizeof(sc_control_partial) - sc_control_used) count = sizeof(sc_control_partial) - sc_control_used;
        memcpy(sc_control_partial + sc_control_used, sc_control_queue, count);
        sc_control_used += count; sc_control_length -= count;
        memmove(sc_control_queue, sc_control_queue + count, sc_control_length);
        ReleaseSRWLockExclusive(&sc_control_lock);
        size_t consumed = 0;
        while (!g_shutdown && consumed < sc_control_used)
        {
            int used = kvm_server_inputdata((char *)sc_control_partial + consumed, (int)(sc_control_used - consumed), sc_writer, sc_writer_reserved);
            if (used <= 0) break;
            consumed += (size_t)used;
        }
        memmove(sc_control_partial, sc_control_partial + consumed, sc_control_used - consumed);
        sc_control_used -= consumed;
        if (sc_control_used == sizeof(sc_control_partial)) { g_shutdown = 1; return 0; }
        AcquireSRWLockExclusive(&sc_control_lock);
        int empty = sc_control_length == 0;
        ReleaseSRWLockExclusive(&sc_control_lock);
        if (empty) return 1;
    }
    return 0;
}
static void sc_reset_session(void)
{
    sc_release_desktop(); sc_platform_finish();
    sc_tier = 1440; sc_sequence = sc_acknowledged = 0;
    sc_epoch_initialized = 0; sc_feedback = sc_delta = sc_delta_blocked = 0;
    sc_force = 1; sc_encoded_width = sc_encoded_height = sc_source_width = sc_source_height = 0;
    sc_previous_epoch = sc_previous_sequence = sc_delta_frames = sc_ack_delay = 0;
    sc_display_generation++; COMPRESSION_QUALITY = 90;
    memset(sc_sent, 0, sizeof(sc_sent)); sc_control_used = 0;
    AcquireSRWLockExclusive(&sc_control_lock); sc_control_length = 0; ReleaseSRWLockExclusive(&sc_control_lock);
}
#endif
