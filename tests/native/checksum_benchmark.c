#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "screen_control_protocol.h"

static volatile uint32_t sink;

static uint64_t elapsed_ns(struct timespec start, struct timespec end)
{
    return (uint64_t)(end.tv_sec - start.tv_sec) * 1000000000u + end.tv_nsec - start.tv_nsec;
}

/* 只用于有下一像素的内部 tile；重现旧版每行额外读四字节的运算。 */
static uint32_t previous_checksum(const unsigned char *desktop, int stride, int width, int height)
{
    uint32_t checksum = 0;
    for (int row = 0; row < height; ++row) {
        const unsigned char *begin = desktop + (size_t)row * stride * 3;
        const unsigned char *end = begin + width * 3;
        while (begin + 4 <= end) {
            uint32_t word;
            memcpy(&word, begin, sizeof(word));
            checksum = checksum * 0x01000193u ^ word;
            begin += 4;
        }
        uint32_t extra;
        memcpy(&extra, end - 3, sizeof(extra));
        checksum = checksum * 0x01000193u ^ extra;
    }
    return checksum;
}

int main(int argc, char **argv)
{
    const int stride = 1920, rows = 1088, width = 32, height = 32, rounds = 100000;
    const size_t length = (size_t)stride * rows * 3;
    unsigned char *desktop = malloc(length);
    assert(desktop != NULL);
    for (size_t i = 0; i < length; ++i) desktop[i] = (unsigned char)(i * 37);
    int rust_first = argc > 1 && strcmp(argv[1], "rust-first") == 0;
    for (int pass = 0; pass < 2; ++pass) {
        int rust = (pass == 0) == rust_first;
        struct timespec start, end;
        clock_gettime(CLOCK_MONOTONIC, &start);
        for (int i = 0; i < rounds; ++i) {
            desktop[0] ^= 1;
            uint32_t checksum;
            if (rust) {
                assert(sc_tile_crc_rgb24(desktop, length, stride, width,
                                         0, 0, width, height, &checksum) == 1);
            } else {
                checksum = previous_checksum(desktop, stride, width, height);
            }
            sink ^= checksum;
        }
        clock_gettime(CLOCK_MONOTONIC, &end);
        printf("%s %.3f 微秒/tile\n", rust ? "Rust" : "C 基线", (double)elapsed_ns(start, end) / rounds / 1000);
    }
    free(desktop);
    return 0;
}
