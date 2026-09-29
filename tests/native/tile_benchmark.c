#define _POSIX_C_SOURCE 200809L
#include "screen_control_protocol.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t elapsed_ns(struct timespec start, struct timespec end)
{
    return (uint64_t)(end.tv_sec - start.tv_sec) * 1000000000u + end.tv_nsec - start.tv_nsec;
}

static void c_copy(unsigned char *target, const unsigned char *desktop,
                   size_t stride, size_t x, size_t y, size_t width, size_t height)
{
    for (size_t row = 0; row < height; ++row) {
        memcpy(target + row * width * 3, desktop + ((y + row) * stride + x) * 3, width * 3);
    }
}

int main(int argc, char **argv)
{
    int rust_first = argc > 1 && strcmp(argv[1], "rust-first") == 0;
    const int screen_width = 1920, tile_width = 32, stride = 1920;
    const int x = 64, y = 64, width = 256, height = 256, rounds = 20000;
    const size_t desktop_len = (size_t)stride * 1088 * 3;
    const size_t target_len = (size_t)width * height * 3;
    unsigned char *desktop = malloc(desktop_len);
    unsigned char *target = malloc(target_len);
    assert(desktop && target);
    for (size_t i = 0; i < desktop_len; ++i) desktop[i] = (unsigned char)i;
    struct timespec start, end;
    volatile unsigned int checksum = 0;

    uint64_t c_time = 0, rust_time = 0;
    for (int pass = 0; pass < 2; ++pass) {
        int use_rust = (pass == 0) == rust_first;
        clock_gettime(CLOCK_MONOTONIC, &start);
        for (int i = 0; i < rounds; ++i) {
            desktop[(size_t)y * stride * 3 + x * 3] = (unsigned char)i;
            if (use_rust) {
                assert(sc_tile_copy_rgb24(target, target_len, desktop, desktop_len,
                                          screen_width, tile_width, x, y, width, height));
            } else {
                c_copy(target, desktop, stride, x, y, width, height);
            }
            checksum += target[0];
        }
        clock_gettime(CLOCK_MONOTONIC, &end);
        if (use_rust) rust_time = elapsed_ns(start, end);
        else c_time = elapsed_ns(start, end);
    }
    printf("256x256 RGB24: C %.1f ns/tile, Rust FFI %.1f ns/tile; checksum %u\n",
           (double)c_time / rounds, (double)rust_time / rounds, checksum);
    free(target);
    free(desktop);
    return 0;
}
