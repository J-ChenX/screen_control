/* Linux X11／JPEG／管道适配；帧策略只有公共实现。 */
#ifndef SC_ADAPTIVE_DESKTOP_H
#define SC_ADAPTIVE_DESKTOP_H
#include <errno.h>
#include <time.h>
#include <sys/random.h>
#include "linux_compression.h"
extern int COMPRESSION_QUALITY;
extern int slave2master[2];
extern unsigned char *jpeg_buffer;
extern int jpeg_buffer_length;
static uint64_t sc_now_ms(void)
{
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static unsigned int sc_platform_epoch(void)
{
    unsigned int value = 0;
    if (getrandom(&value, sizeof(value), 0) != sizeof(value)) value = (unsigned int)sc_now_ms() ^ ((unsigned int)getpid() << 16);
    return value;
}
static int sc_platform_write(const void *buffer, size_t length)
{
    const unsigned char *p = buffer;
    while (length > 0)
    {
        ssize_t count = write(slave2master[1], p, length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        p += count; length -= (size_t)count;
    }
    return 1;
}
static int sc_platform_resize(unsigned char *destination, size_t length, const unsigned char *source, uint64_t source_length, ScDesktopSize dimensions)
{
    unsigned int stride = ((unsigned int)SCREEN_WIDTH + TILE_WIDTH - 1) / TILE_WIDTH * TILE_WIDTH;
    return sc_desktop_resize(destination, length, source, source_length, stride, SCREEN_WIDTH, SCREEN_HEIGHT, dimensions.width, dimensions.height);
}
static int sc_platform_encode(const unsigned char *source, unsigned int width, unsigned int height, int quality, unsigned char **output, size_t *length)
{
    jpeg_buffer_length = 0;
    if (write_JPEG_buffer((unsigned char *)source, width, height, quality) != 0 || !jpeg_buffer || jpeg_buffer_length <= 0) return 0;
    *output = jpeg_buffer; *length = (size_t)jpeg_buffer_length; return 1;
}
static void sc_platform_finish(void) { finish_JPEG_tile(); }
static void sc_platform_resolution(void) { kvm_send_resolution(); }
#include "sc_adaptive_desktop_core.h"
#endif
