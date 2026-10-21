/* 公共桌面协议、双帧信用和 JPEG 增量；平台提供时钟、采集转换、编码及写回调。 */
#ifndef SC_ADAPTIVE_DESKTOP_CORE_H
#define SC_ADAPTIVE_DESKTOP_CORE_H
#define SC_FRAME_METADATA 0x7f00
#define SC_FRAME_ACK 0x7f01
#define SC_FRAME_MOUSE MNG_KVM_MOUSE
#define SC_FRAME_DISCARD 0x7f03
#define SC_FRAME_CAPABILITY 0x7f04
#define SC_FRAME_RESET 0x7f05
#define SC_FRAME_HISTORY 128
#define SC_ADAPTIVE_JPEG 129
#define SC_ADAPTIVE_DELTA 130
static unsigned int sc_tier = 1440, sc_epoch = 1, sc_sequence = 0, sc_acknowledged = 0;
static unsigned int sc_encoded_width = 0, sc_encoded_height = 0, sc_source_width = 0, sc_source_height = 0;
static unsigned int sc_ack_delay = 0;
static uint64_t sc_feedback_at = 0;
static int sc_epoch_initialized = 0;
static int sc_feedback = 0, sc_force = 1;
static int sc_delta = 0, sc_delta_blocked = 0;
static unsigned int sc_previous_epoch = 0, sc_previous_sequence = 0, sc_delta_frames = 0;
static unsigned int sc_display_generation = 0;
static unsigned char *sc_scaled = NULL, *sc_previous = NULL;
static size_t sc_capacity = 0, sc_previous_size = 0;
static unsigned char *sc_patch = NULL;
static size_t sc_patch_capacity = 0;
typedef struct { unsigned int epoch, sequence, width, height, source_width, source_height; uint64_t sent_at; unsigned int display_generation; } ScSentFrame;
static ScSentFrame sc_sent[SC_FRAME_HISTORY];

static void sc_initialize_epoch(void)
{
    if (sc_epoch_initialized) return;
    unsigned int value = sc_platform_epoch();
    sc_epoch = value ? value : 1; sc_epoch_initialized = 1;
}
static void sc_next_epoch(void) { sc_epoch++; if (sc_epoch == 0) sc_epoch = 1; }
static void sc_u16(unsigned char *p, unsigned int value) { p[0] = (unsigned char)(value >> 8); p[1] = (unsigned char)value; }
static void sc_u32(unsigned char *p, unsigned int value) { sc_u16(p, value >> 16); sc_u16(p + 2, value); }
static unsigned int sc_read_u16(const unsigned char *p) { return ((unsigned int)p[0] << 8) | p[1]; }
static unsigned int sc_read_u32(const unsigned char *p) { return ((unsigned int)p[0] << 24) | ((unsigned int)p[1] << 16) | ((unsigned int)p[2] << 8) | p[3]; }
static ScDesktopSize sc_current_size(void) { return sc_desktop_size((uint32_t)SCREEN_WIDTH, (uint32_t)SCREEN_HEIGHT, sc_tier); }
static void sc_refresh_frame(void) { sc_force = 1; }
/* 旧查看者的刷新使共享流本次固定回退，避免双方反复协商。 */
static void sc_legacy_refresh(void)
{
    sc_delta_blocked = 1;
    sc_delta = 0; sc_refresh_frame();
}
static void sc_accept_ack(const unsigned char *packet, int size, int discarded)
{
    if (size != 12) return;
    unsigned int epoch = sc_read_u32(packet + 4), sequence = sc_read_u32(packet + 8);
    ScSentFrame *frame = &sc_sent[sequence % SC_FRAME_HISTORY];
    if (frame->sequence != sequence || frame->epoch != epoch || sequence > sc_sequence) return;
    /* 共享流中快查看者可能已经累计确认；慢查看者仍可请求完整基线。 */
    if (discarded) sc_refresh_frame();
    if (sequence <= sc_acknowledged) return;
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
    if (frame->sequence != sequence || frame->epoch != epoch || frame->display_generation != sc_display_generation || frame->source_width != (unsigned int)SCREEN_WIDTH || frame->source_height != (unsigned int)SCREEN_HEIGHT) return -1;
    unsigned int mapped = sc_desktop_input(value, vertical ? frame->height : frame->width, vertical ? frame->source_height : frame->source_width);
    return mapped == UINT32_MAX ? -1 : (int)mapped;
}
/* 轮询前只查询窗口；处理已到控制消息后才允许超时回退。 */
static int sc_waiting_for_feedback(int allow_timeout)
{
    if (!sc_feedback || sc_sequence - sc_acknowledged < 2) return 0;
    /* 空窗口的静止时间不属于新帧等待；保留两秒反馈停滞保护。 */
    uint64_t waiting_since = sc_feedback_at;
    const ScSentFrame *oldest = &sc_sent[(sc_acknowledged + 1) % SC_FRAME_HISTORY];
    if (oldest->sequence == sc_acknowledged + 1 && oldest->sent_at > waiting_since) waiting_since = oldest->sent_at;
    // 共享流中的旧客户端没有展示反馈；最后一个新客户端退出后不能永久饿死旧查看者。
    if (allow_timeout && sc_now_ms() - waiting_since >= 2000) { sc_feedback = 0; sc_legacy_refresh(); return 0; }
    return 1;
}
static void sc_release_desktop(void)
{
    free(sc_scaled); free(sc_previous); sc_scaled = sc_previous = NULL;
    sc_capacity = sc_previous_size = 0;
    free(sc_patch); sc_patch = NULL; sc_patch_capacity = 0;
}
/* 单矩形与 JPEG 块边界对齐，同次采集的一张图片可一次提交，不引入混帧。 */
static int sc_changed_rectangle(unsigned int width, unsigned int height, unsigned int *x, unsigned int *y, unsigned int *w, unsigned int *h)
{
    unsigned int left = width, top = height, right = 0, bottom = 0;
    size_t stride = (size_t)width * 3;
    for (unsigned int row = 0; row < height; row++)
    {
        const unsigned char *a = sc_scaled + row * stride, *b = sc_previous + row * stride;
        if (memcmp(a, b, stride) == 0) continue;
        if (row < top) top = row;
        bottom = row + 1;
        unsigned int first = 0, last = width;
        while (first < width && memcmp(a + first * 3, b + first * 3, 3) == 0) first++;
        while (last > first && memcmp(a + (last - 1) * 3, b + (last - 1) * 3, 3) == 0) last--;
        if (first < left) left = first;
        if (last > right) right = last;
    }
    if (left == width) return 0;
    *x = left / 16 * 16; *y = top / 16 * 16;
    right = (right + 15) / 16 * 16; bottom = (bottom + 15) / 16 * 16;
    if (right > width) right = width;
    if (bottom > height) bottom = height;
    *w = right - *x; *h = bottom - *y;
    return 1;
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
    if (!sc_platform_resize(sc_scaled, required, source, source_length, dimensions)) return 0;
    if (sc_encoded_width != dimensions.width || sc_encoded_height != dimensions.height || sc_source_width != (unsigned int)SCREEN_WIDTH || sc_source_height != (unsigned int)SCREEN_HEIGHT)
    {
        sc_next_epoch(); sc_encoded_width = dimensions.width; sc_encoded_height = dimensions.height;
        sc_source_width = SCREEN_WIDTH; sc_source_height = SCREEN_HEIGHT;
        sc_previous_size = 0; sc_refresh_frame();
        sc_platform_resolution();
    }
    if (sc_sequence == UINT32_MAX) { sc_sequence = sc_acknowledged = 0; sc_next_epoch(); memset(sc_sent, 0, sizeof(sc_sent)); sc_refresh_frame(); }
    unsigned int x = 0, y = 0, width = dimensions.width, height = dimensions.height;
    int delta = 0;
    if (!sc_force && sc_previous_size == required)
    {
        if (!sc_changed_rectangle(dimensions.width, dimensions.height, &x, &y, &width, &height)) return 1;
        delta = sc_delta && sc_previous_epoch == sc_epoch && sc_delta_frames < 120 &&
            (uint64_t)width * height * 10 < (uint64_t)dimensions.width * dimensions.height * 6;
    }
    const unsigned char *encoding = sc_scaled;
    if (delta)
    {
        size_t length = (size_t)width * height * 3;
        if (sc_patch_capacity < length)
        {
            unsigned char *replacement = malloc(length);
            if (!replacement) return 0;
            free(sc_patch); sc_patch = replacement; sc_patch_capacity = length;
        }
        for (unsigned int row = 0; row < height; row++)
            memcpy(sc_patch + (size_t)row * width * 3, sc_scaled + ((size_t)(row + y) * dimensions.width + x) * 3, (size_t)width * 3);
        encoding = sc_patch;
    }
    else { x = y = 0; width = dimensions.width; height = dimensions.height; }
    unsigned char *jpeg_buffer = NULL;
    size_t jpeg_buffer_length = 0;
    if (!sc_platform_encode(encoding, width, height, COMPRESSION_QUALITY, &jpeg_buffer, &jpeg_buffer_length) || !jpeg_buffer || !jpeg_buffer_length) return 0;
    unsigned int sequence = ++sc_sequence;
    unsigned char metadata[56] = {0}, header[16] = {0}, capability[8] = {0};
    size_t metadata_size = sc_delta ? 56 : 40;
    sc_u16(metadata, SC_FRAME_METADATA); sc_u16(metadata + 2, metadata_size);
    sc_u16(metadata + 4, sc_delta ? 2 : 1); sc_u16(metadata + 6, (delta ? 4 : 1) | (sc_feedback ? 2 : 0));
    sc_u32(metadata + 8, sc_epoch); sc_u32(metadata + 12, sequence);
    sc_u16(metadata + 16, SCREEN_WIDTH); sc_u16(metadata + 18, SCREEN_HEIGHT);
    sc_u16(metadata + 20, dimensions.width); sc_u16(metadata + 22, dimensions.height);
    sc_u16(metadata + 24, sc_tier); sc_u16(metadata + 26, COMPRESSION_QUALITY);
    uint64_t processing = sc_now_ms() - started;
    sc_u32(metadata + 28, processing > 60000 ? 60000 : (unsigned int)processing);
    sc_u32(metadata + 32, sc_ack_delay);
    if (sc_delta)
    {
        sc_u32(metadata + 36, delta ? sc_previous_sequence : 0);
        sc_u16(metadata + 40, x); sc_u16(metadata + 42, y);
        sc_u16(metadata + 44, width); sc_u16(metadata + 46, height);
        sc_u32(metadata + 48, delta ? sc_previous_epoch : 0);
    }
    sc_u16(capability, SC_FRAME_CAPABILITY); sc_u16(capability + 2, sizeof(capability));
    sc_u16(capability + 4, 2); sc_u16(capability + 6, sc_delta_blocked ? 0 : 1);
    size_t header_size = jpeg_buffer_length > 65500 ? 16 : 8;
    if (header_size == 16)
    {
        sc_u16(header, MNG_JUMBO); sc_u16(header + 2, 8); sc_u32(header + 4, (unsigned int)jpeg_buffer_length + 8);
        sc_u16(header + 8, MNG_KVM_PICTURE);
    }
    else { sc_u16(header, MNG_KVM_PICTURE); sc_u16(header + 2, (unsigned int)jpeg_buffer_length + 8); }
    sc_u16(header + (header_size == 16 ? 12 : 4), x); sc_u16(header + (header_size == 16 ? 14 : 6), y);
    ScSentFrame sent = {sc_epoch, sequence, dimensions.width, dimensions.height, (unsigned int)SCREEN_WIDTH, (unsigned int)SCREEN_HEIGHT, sc_now_ms(), sc_display_generation};
    sc_sent[sequence % SC_FRAME_HISTORY] = sent;
    int success = sc_platform_write(capability, sizeof(capability)) && sc_platform_write(metadata, metadata_size) && sc_platform_write(header, header_size) && sc_platform_write(jpeg_buffer, (size_t)jpeg_buffer_length);
    if (success)
    {
        memcpy(sc_previous, sc_scaled, required); sc_previous_size = required; sc_force = 0;
        sc_previous_epoch = sc_epoch; sc_previous_sequence = sequence;
        sc_delta_frames = delta ? sc_delta_frames + 1 : 0;
    }
    sc_platform_finish();
    return success;
}
#endif
