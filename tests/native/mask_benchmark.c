#define _POSIX_C_SOURCE 200809L
#include "screen_control_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* 对照原版按四字节 XOR 的算法；用 memcpy 消除基准自身的未对齐 UB。 */
__attribute__((noinline)) static void baseline(unsigned char *out, const unsigned char *in, unsigned int size, uint32_t key)
{
    unsigned int i = 0;
    for (; size - i >= 4; i += 4) {
        uint32_t word;
        memcpy(&word, in + i, 4);
        word ^= key;
        memcpy(out + i, &word, 4);
    }
    for (; i < size; ++i) out[i] = in[i] ^ ((unsigned char*)&key)[i % 4];
}
static double now(void) {
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC, &time);
    return (double)time.tv_sec + (double)time.tv_nsec / 1e9;
}
int main(void)
{
    const unsigned int sizes[] = {125, 4096, 16384, 65536};
    volatile unsigned char sink = 0;
    for (unsigned int s = 0; s < 4; ++s) {
        unsigned int size = sizes[s], loops = 268435456 / size;
        unsigned char *in = malloc(size + 1), *out = malloc(size + 1);
        if (!in || !out) return 1;
        memset(in, 0x42, size + 1);
        for (unsigned int round = 0; round < 3; ++round) {
            double times[2];
            /* 轮次交错，减少固定先后顺序对缓存/频率的影响。 */
            for (unsigned int pass = 0; pass < 2; ++pass) {
                unsigned int rust = (pass + round) % 2;
                double start = now();
                for (unsigned int i = 0; i < loops; ++i) {
                    if (rust) {
                        if (!sc_ws_mask_copy(out + 1, in + 1, size, 0x12345678)) return 2;
                    } else baseline(out + 1, in + 1, size, 0x12345678);
                    sink ^= out[1];
                }
                times[rust] = now() - start;
            }
            printf("{\"size\":%u,\"round\":%u,\"c_seconds\":%.6f,\"rust_seconds\":%.6f,\"rust_over_c\":%.3f}\n", size, round, times[0], times[1], times[1] / times[0]);
        }
        free(in); free(out);
    }
    return sink == 255;
}
