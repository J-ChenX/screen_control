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

static void c_convert(unsigned char *output, const unsigned char *input,
                      int width, int height, int output_stride, int output_height)
{
    memset(output, 0, (size_t)output_stride * output_height * 3);
    for (int row = 0; row < height; ++row) {
        const uint32_t *pixels = (const uint32_t *)(input + (size_t)row * width * 4);
        unsigned char *target = output + (size_t)row * output_stride * 3;
        for (int col = 0; col < width; ++col) {
            uint32_t pixel = pixels[col];
            target[col * 3] = (unsigned char)(pixel >> 16);
            target[col * 3 + 1] = (unsigned char)(pixel >> 8);
            target[col * 3 + 2] = (unsigned char)pixel;
        }
    }
}

int main(int argc, char **argv)
{
    const int width = 1920, height = 1080, output_height = 1088, rounds = 40;
    const size_t input_len = (size_t)width * height * 4;
    const size_t output_len = (size_t)width * output_height * 3;
    unsigned char *input = malloc(input_len);
    unsigned char *output = malloc(output_len);
    assert(input && output);
    for (size_t i = 0; i < input_len; ++i) input[i] = (unsigned char)i;
    ScXImageMeta meta = {width, height, width * 4, width, output_height,
                         32, 0, 0, 0xff0000, 0xff00, 0xff};
    int rust_first = argc > 1 && strcmp(argv[1], "rust-first") == 0;
    uint64_t c_time = 0, rust_time = 0;
    volatile unsigned int checksum = 0;
    struct timespec start, end;
    for (int pass = 0; pass < 2; ++pass) {
        int use_rust = (pass == 0) == rust_first;
        clock_gettime(CLOCK_MONOTONIC, &start);
        for (int i = 0; i < rounds; ++i) {
            input[0] = (unsigned char)i;
            if (use_rust) {
                assert(sc_ximage_rgb24(output, output_len, input, input_len, meta));
            } else {
                c_convert(output, input, width, height, width, output_height);
            }
            checksum += output[0];
        }
        clock_gettime(CLOCK_MONOTONIC, &end);
        if (use_rust) rust_time = elapsed_ns(start, end);
        else c_time = elapsed_ns(start, end);
    }
    printf("1920x1080 BGRA->RGB24: C %.3f ms/frame, Rust FFI %.3f ms/frame; checksum %u\n",
           (double)c_time / rounds / 1000000, (double)rust_time / rounds / 1000000, checksum);
    free(output);
    free(input);
    return 0;
}
