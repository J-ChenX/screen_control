#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <X11/Xlib.h>
#include <jpeglib.h>
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "meshcore/KVM/Linux/linux_tile.h"

int SCREEN_WIDTH = 32, SCREEN_HEIGHT = 32, TILE_WIDTH = 32;
int TILE_HEIGHT = 32, TILE_WIDTH_COUNT = 1, TILE_HEIGHT_COUNT = 1, COMPRESSION_RATIO = 1;
struct tileInfo_t **g_tileInfo = NULL;
extern unsigned char *jpeg_buffer;
extern int jpeg_buffer_length;
extern void *tilebuffer;
#ifdef JPEG_BASELINE
static void finish_JPEG_tile(void) { }
static void release_JPEG_buffer(void) { free(jpeg_buffer); }
#else
void finish_JPEG_tile(void);
void release_JPEG_buffer(void);
#endif
void ILib_POSIX_CrashHandler(int code) { exit(code); }
int ILibMemory_Copy_s(void *destination, size_t destination_size, void *source, size_t source_length)
{
    if (destination == NULL || source == NULL || source_length > destination_size) return -1;
    memcpy(destination, source, source_length);
    return 0;
}
int getScreenBuffer(char **desktop, long long *desktopsize, XImage *image);
int calc_opt_compr_send(int x, int y, int captureWidth, int captureHeight,
                        void *desktop, long long desktopsize, void **buffer, long long *bufferSize);

static uint64_t elapsed_ns(struct timespec start, struct timespec end)
{
    return (uint64_t)(end.tv_sec - start.tv_sec) * 1000000000u + end.tv_nsec - start.tv_nsec;
}

int main(int argc, char **argv)
{
    int huge = argc > 1 && strstr(argv[1], "huge") != NULL;
    int large = huge || (argc > 1 && strstr(argv[1], "large") != NULL);
    int benchmark = argc > 1 && strstr(argv[1], "benchmark") != NULL;
    int width = huge ? 2048 : (large ? 512 : 32);
    SCREEN_WIDTH = SCREEN_HEIGHT = width;
    unsigned char *raw = malloc((size_t)width * width * 4);
    assert(raw != NULL);
    for (int i = 0; i < width * width; ++i) {
        raw[i * 4] = large ? (unsigned char)(i * 37) : 50;
        raw[i * 4 + 1] = large ? (unsigned char)(i * 17 + i / width) : 100;
        raw[i * 4 + 2] = large ? (unsigned char)(i * 13 + i / 7) : 200;
        raw[i * 4 + 3] = 0;
    }
    XImage image = {0};
    image.width = width; image.height = width; image.bits_per_pixel = 32;
    image.bytes_per_line = width * 4; image.byte_order = LSBFirst;
    image.red_mask = 0xff0000; image.green_mask = 0xff00; image.blue_mask = 0xff;
    image.data = (char *)raw;
    char *desktop = NULL;
    long long desktop_size = 0;
    assert(getScreenBuffer(&desktop, &desktop_size, &image) == 0);
    void *output = NULL;
    long long output_size = 0;
    int rounds = benchmark ? (huge ? 10 : (large ? 200 : 10000)) : 1;
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < rounds; ++i) {
        assert(calc_opt_compr_send(0, 0, width, width, desktop, desktop_size,
                                   &output, &output_size) == 0);
        assert(jpeg_buffer != NULL && jpeg_buffer_length > 100);
        if (i + 1 < rounds) finish_JPEG_tile();
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    struct jpeg_decompress_struct decoder;
    struct jpeg_error_mgr error;
    decoder.err = jpeg_std_error(&error);
    jpeg_create_decompress(&decoder);
    jpeg_mem_src(&decoder, jpeg_buffer, (unsigned long)jpeg_buffer_length);
    assert(jpeg_read_header(&decoder, TRUE) == JPEG_HEADER_OK);
    jpeg_start_decompress(&decoder);
    assert(decoder.output_width == (unsigned int)width &&
           decoder.output_height == (unsigned int)width && decoder.output_components == 3);
    unsigned char *line = malloc((size_t)width * 3);
    assert(line != NULL);
    JSAMPROW rows[1] = {line};
    int mismatches = 0;
    while (decoder.output_scanline < decoder.output_height) {
        jpeg_read_scanlines(&decoder, rows, 1);
        if (!large) for (int i = 0; i < width; ++i) {
            mismatches += abs(line[i * 3] - 200) > 8;
            mismatches += abs(line[i * 3 + 1] - 100) > 8;
            mismatches += abs(line[i * 3 + 2] - 50) > 8;
        }
    }
    jpeg_finish_decompress(&decoder);
    jpeg_destroy_decompress(&decoder);
    uint64_t hash = 1469598103934665603ull;
    for (int i = 0; i < jpeg_buffer_length; ++i) {
        hash = (hash ^ jpeg_buffer[i]) * 1099511628211ull;
    }
    printf("JPEG 路径：%d×%d，%d 帧，%d 字节，FNV64=%016llx，解码通道不一致 %d，%.1f 微秒/帧\n",
           width, width, rounds, jpeg_buffer_length, (unsigned long long)hash, mismatches,
           (double)elapsed_ns(start, end) / rounds / 1000);
#ifndef JPEG_BASELINE
    if (!large) {
        struct tileInfo_t info = {.crc = 0xff, .flag = TILE_TODO};
        struct tileInfo_t *rows[1] = {&info};
        g_tileInfo = rows;
        assert(getTileAt(0, 0, &output, &output_size, desktop, desktop_size, 0, 0) == 0);
        assert(output != NULL && output_size > 100);
        free(output);
        info.flag = TILE_TODO;
        output = NULL;
        assert(getTileAt(0, 0, &output, &output_size, desktop, desktop_size, 0, 0) == 0);
        assert(output == NULL && output_size == 0);
        desktop[desktop_size - 1] ^= 0x80;
        info.flag = TILE_TODO;
        assert(getTileAt(0, 0, &output, &output_size, desktop, desktop_size, 0, 0) == 0);
        assert(output != NULL && output_size > 100);
        free(output);
        info.flag = TILE_TODO;
        output = NULL;
        assert(getTileAt(0, 0, &output, &output_size, desktop, desktop_size - 1, 0, 0) == -1);
        assert(output == NULL && output_size == 0);
        g_tileInfo = NULL;
    }
#endif
#ifndef JPEG_BASELINE
    if (huge && jpeg_buffer_length > 1024 * 1024) {
        finish_JPEG_tile();
        assert(jpeg_buffer == NULL && jpeg_buffer_length == 0);
    }
#endif
    free(line);
    free(raw);
    free(desktop);
    free(tilebuffer);
    release_JPEG_buffer();
    return mismatches ? 1 : 0;
}
