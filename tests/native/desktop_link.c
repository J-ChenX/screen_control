/* 隔离慢链路驱动：编码参数来自实际浏览器反馈，不安装系统限速规则。 */
#define main desktop_delta_reference_main
#include "desktop_delta.c"
#undef main

int main(int argc, char **argv)
{
    assert(argc == 2);
    const char *scenario = argv[1];
    size_t length = (size_t)SCREEN_WIDTH * SCREEN_HEIGHT * 3;
    unsigned char *source = malloc(length), *base = malloc(length);
    assert(source && base);
    for (unsigned y = 0; y < (unsigned)SCREEN_HEIGHT; y++) for (unsigned x = 0; x < (unsigned)SCREEN_WIDTH; x++)
        for (unsigned c = 0; c < 3; c++) base[((size_t)y * SCREEN_WIDTH + x) * 3 + c] =
            (unsigned char)(y % 24 >= 7 && y % 24 < 17 && x % 13 >= 3 && x % 13 < 9 ? 35 + c * 12 : 230 + c * 8);
    sc_feedback = 1; sc_feedback_at = sc_now_ms();
    unsigned index, quality, tier, delta, force, ack_epoch, ack_sequence;
    while (scanf("%u %u %u %u %u %u %u", &index, &quality, &tier, &delta, &force, &ack_epoch, &ack_sequence) == 7)
    {
        if (index == UINT32_MAX) break;
        unsigned char ack[12] = {0}; sc_u16(ack, SC_FRAME_ACK); sc_u16(ack + 2, 12);
        sc_u32(ack + 4, ack_epoch); sc_u32(ack + 8, ack_sequence); sc_accept_ack(ack, 12, 0);
        if (COMPRESSION_QUALITY != (int)quality || sc_tier != tier || force) sc_refresh_frame();
        COMPRESSION_QUALITY = quality; sc_tier = tier;
#ifdef SC_ADAPTIVE_DELTA
        sc_delta = delta && !sc_delta_blocked;
#else
        (void)delta;
#endif
        wire_length = 0; double started = micros();
        if (!sc_waiting_for_feedback(1))
        {
            memcpy(source, base, length);
            if (!strcmp(scenario, "local")) {
                unsigned left = 640 + (index % 12) * 8;
                for (unsigned y = 416; y < 480; y++) for (unsigned x = left; x < left + 128; x++)
                    for (unsigned c = 0; c < 3; c++) source[((size_t)y * SCREEN_WIDTH + x) * 3 + c] = 70 + (index % 3) * 50 + c * 15;
            } else if (!strcmp(scenario, "scroll")) {
                for (unsigned y = 0; y < (unsigned)SCREEN_HEIGHT; y++) memcpy(source + (size_t)y * SCREEN_WIDTH * 3,
                    base + (size_t)((y + index * 5) % SCREEN_HEIGHT) * SCREEN_WIDTH * 3, (size_t)SCREEN_WIDTH * 3);
            } else if (!strcmp(scenario, "motion")) {
                for (size_t p = 0; p < length; p++) source[p] = (unsigned char)(base[p] + index * 17 + (p / 3 % SCREEN_WIDTH) / 32);
            }
            assert(sc_send_desktop(source, length, sc_now_ms()));
        }
        unsigned char header[8]; sc_u32(header, wire_length); sc_u32(header + 4, (unsigned)(micros() - started));
        assert(fwrite(header, 1, 8, stdout) == 8);
        if (wire_length) assert(fwrite(wire, 1, wire_length, stdout) == wire_length);
        fflush(stdout);
    }
    free(source); free(base); sc_release_desktop(); release_JPEG_buffer(); return 0;
}
