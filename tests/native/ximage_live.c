#include "screen_control_protocol.h"
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>

int SCREEN_WIDTH;
int SCREEN_HEIGHT;
int TILE_WIDTH = 32;
int getScreenBuffer(char **desktop, long long *desktopsize, XImage *image);

static uint8_t channel(unsigned long pixel, unsigned long mask)
{
    unsigned int shift = 0, bits = 0;
    while ((mask & 1) == 0) { mask >>= 1; ++shift; }
    for (unsigned long value = mask; value != 0; value >>= 1) bits += value & 1;
    unsigned long value = (pixel >> shift) & mask;
    return bits >= 8 ? (uint8_t)(value >> (bits - 8)) : (uint8_t)(value << (8 - bits));
}

int main(void)
{
    Display *display = XOpenDisplay(NULL);
    if (display == NULL || !XShmQueryExtension(display)) return 2;
    int screen = DefaultScreen(display);
    int width = DisplayWidth(display, screen), height = DisplayHeight(display, screen);
    SCREEN_WIDTH = width;
    SCREEN_HEIGHT = height;
    XShmSegmentInfo shm = {0};
    XImage *image = XShmCreateImage(display, DefaultVisual(display, screen),
                                    DefaultDepth(display, screen), ZPixmap, NULL, &shm,
                                    (unsigned int)width, (unsigned int)height);
    if (image == NULL || image->bytes_per_line <= 0 || image->height <= 0) {
        if (image != NULL) XDestroyImage(image);
        XCloseDisplay(display);
        return 3;
    }
    uint64_t source_len = (uint64_t)image->bytes_per_line * image->height;
    unsigned int output_stride = ((unsigned int)width + 31) / 32 * 32;
    unsigned int output_height = ((unsigned int)height + 31) / 32 * 32;
    uint64_t output_len = (uint64_t)output_stride * output_height * 3;
    if (source_len > 1024ULL * 1024 * 1024 || output_len > 1024ULL * 1024 * 1024) {
        XDestroyImage(image);
        XCloseDisplay(display);
        return 4;
    }
    shm.shmid = shmget(IPC_PRIVATE, (size_t)source_len, IPC_CREAT | 0600);
    if (shm.shmid < 0) {
        XDestroyImage(image);
        XCloseDisplay(display);
        return 5;
    }
    shm.shmaddr = shmat(shm.shmid, NULL, 0);
    if (shm.shmaddr == (char *)-1) {
        shmctl(shm.shmid, IPC_RMID, NULL);
        XDestroyImage(image);
        XCloseDisplay(display);
        return 6;
    }
    image->data = shm.shmaddr;
    shm.readOnly = False;
    if (!XShmAttach(display, &shm)) {
        XDestroyImage(image);
        shmdt(shm.shmaddr);
        shmctl(shm.shmid, IPC_RMID, NULL);
        XCloseDisplay(display);
        return 7;
    }
    XSync(display, False);
    if (!XShmGetImage(display, RootWindow(display, screen), image, 0, 0, AllPlanes)) {
        XShmDetach(display, &shm);
        XSync(display, False);
        XDestroyImage(image);
        shmdt(shm.shmaddr);
        shmctl(shm.shmid, IPC_RMID, NULL);
        XCloseDisplay(display);
        return 8;
    }
    uint8_t *output = malloc((size_t)output_len);
    assert(output != NULL);
    ScXImageMeta meta = {(uint32_t)width, (uint32_t)height, (uint32_t)image->bytes_per_line,
                         output_stride, output_height, (uint32_t)image->bits_per_pixel,
                         (uint32_t)image->byte_order, 0,
                         image->red_mask, image->green_mask, image->blue_mask};
    int converted = sc_ximage_rgb24(output, output_len, (uint8_t *)image->data, source_len, meta);
    int mismatches = 0;
    char *via_c = NULL;
    long long via_c_len = 0;
    int c_converted = getScreenBuffer(&via_c, &via_c_len, image) == 0;
    if (c_converted && (via_c_len != (long long)output_len ||
                        memcmp(via_c, output, (size_t)output_len) != 0)) c_converted = 0;
    if (converted) {
        for (int sample = 0; sample < 1024; ++sample) {
            int x = (sample * 7919) % width;
            int y = (sample * 1543) % height;
            unsigned long pixel = XGetPixel(image, x, y);
            const uint8_t *rgb = output + ((size_t)y * output_stride + x) * 3;
            mismatches += rgb[0] != channel(pixel, image->red_mask);
            mismatches += rgb[1] != channel(pixel, image->green_mask);
            mismatches += rgb[2] != channel(pixel, image->blue_mask);
        }
    }
    printf("X11 内存对照：Rust=%s，C 调用点=%s，抽样=1024，通道不一致=%d\n",
           converted ? "通过" : "失败", c_converted ? "通过" : "失败", mismatches);
    free(via_c);
    free(output);
    XShmDetach(display, &shm);
    XSync(display, False);
    XDestroyImage(image);
    shmdt(shm.shmaddr);
    shmctl(shm.shmid, IPC_RMID, NULL);
    XCloseDisplay(display);
    return converted && c_converted && mismatches == 0 ? 0 : 1;
}
