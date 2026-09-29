#define _POSIX_C_SOURCE 200809L
#include "meshcore/KVM/Linux/linux_tile.h"
#include "meshcore/meshdefines.h"
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <jpeglib.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>

int SCREEN_WIDTH, SCREEN_HEIGHT;
int TILE_WIDTH = 32, TILE_HEIGHT = 32, TILE_WIDTH_COUNT = 1, TILE_HEIGHT_COUNT = 1;
int COMPRESSION_RATIO = 1;
struct tileInfo_t **g_tileInfo;
extern void *tilebuffer;
void release_JPEG_buffer(void);
void ILib_POSIX_CrashHandler(int code) { exit(code); }
int ILibMemory_Copy_s(void *destination, size_t capacity, void *source, size_t length)
{
    if (destination == NULL || source == NULL || length > capacity) return -1;
    memcpy(destination, source, length);
    return 0;
}

static int write_u32(uint32_t value)
{
    unsigned char bytes[4] = {(unsigned char)value, (unsigned char)(value >> 8),
                              (unsigned char)(value >> 16), (unsigned char)(value >> 24)};
    return fwrite(bytes, 1, sizeof(bytes), stdout) == sizeof(bytes);
}

int main(int argc, char **argv)
{
    int result = 1, attached = 0;
    Display *display = XOpenDisplay(NULL);
    XImage *image = NULL;
    XShmSegmentInfo shm = {.shmid = -1, .shmaddr = NULL};
    char *desktop = NULL;
    void *packet = NULL;
    unsigned char *decoded = NULL;
    struct jpeg_decompress_struct decoder = {0};
    struct jpeg_error_mgr error;
    int decoder_created = 0;
    if (display == NULL || !XShmQueryExtension(display)) goto done;
    int screen = DefaultScreen(display);
    SCREEN_WIDTH = DisplayWidth(display, screen);
    SCREEN_HEIGHT = DisplayHeight(display, screen);
    if (SCREEN_WIDTH < 32 || SCREEN_HEIGHT < 32) goto done;
    image = XShmCreateImage(display, DefaultVisual(display, screen),
                            DefaultDepth(display, screen), ZPixmap, NULL, &shm,
                            (unsigned int)SCREEN_WIDTH, (unsigned int)SCREEN_HEIGHT);
    if (image == NULL || image->bytes_per_line <= 0 || image->height <= 0) goto done;
    uint64_t source_length = (uint64_t)image->bytes_per_line * image->height;
    if (source_length == 0 || source_length > 1024ULL * 1024 * 1024) goto done;
    shm.shmid = shmget(IPC_PRIVATE, (size_t)source_length, IPC_CREAT | 0600);
    if (shm.shmid < 0) goto done;
    shm.shmaddr = shmat(shm.shmid, NULL, 0);
    if (shm.shmaddr == (char *)-1) { shm.shmaddr = NULL; goto done; }
    image->data = shm.shmaddr;
    shm.readOnly = False;
    if (!XShmAttach(display, &shm)) goto done;
    attached = 1;
    XSync(display, False);
    if (!XShmGetImage(display, RootWindow(display, screen), image, 0, 0, AllPlanes)) goto done;

    long long desktop_size = 0, packet_size = 0;
    if (getScreenBuffer(&desktop, &desktop_size, image) != 0) goto done;
    int x = (SCREEN_WIDTH / 64) * 32;
    int y = (SCREEN_HEIGHT / 64) * 32;
    if (argc > 1 && strcmp(argv[1], "top-left") == 0) { x = 0; y = 0; }
    else if (argc > 1 && strcmp(argv[1], "bottom-right") == 0) {
        x = (SCREEN_WIDTH - 1) / 32 * 32;
        y = (SCREEN_HEIGHT - 1) / 32 * 32;
    }
    else if (argc > 1 && strcmp(argv[1], "center") != 0) goto done;
    struct tileInfo_t info = {.crc = 0xff, .flag = TILE_TODO};
    struct tileInfo_t *rows[1] = {&info};
    g_tileInfo = rows;
    if (getTileAt(x, y, &packet, &packet_size, desktop, desktop_size, 0, 0) != 0 ||
        packet == NULL || packet_size <= 8 || packet_size > 65535) goto done;
    const unsigned char *header = packet;
    if (((unsigned int)header[0] << 8 | header[1]) != MNG_KVM_PICTURE ||
        ((unsigned int)header[2] << 8 | header[3]) != (unsigned int)packet_size ||
        ((unsigned int)header[4] << 8 | header[5]) != (unsigned int)x ||
        ((unsigned int)header[6] << 8 | header[7]) != (unsigned int)y) goto done;
    const unsigned char *jpeg = (const unsigned char *)packet + 8;
    size_t jpeg_length = (size_t)packet_size - 8;
    decoder.err = jpeg_std_error(&error);
    jpeg_create_decompress(&decoder);
    decoder_created = 1;
    jpeg_mem_src(&decoder, jpeg, (unsigned long)jpeg_length);
    if (jpeg_read_header(&decoder, TRUE) != JPEG_HEADER_OK) goto done;
    jpeg_start_decompress(&decoder);
    if (decoder.output_width != 32 || decoder.output_height != 32 || decoder.output_components != 3) goto done;
    decoded = malloc(32 * 32 * 3);
    if (decoded == NULL) goto done;
    while (decoder.output_scanline < decoder.output_height) {
        JSAMPROW row[1] = {decoded + (size_t)decoder.output_scanline * 32 * 3};
        if (jpeg_read_scanlines(&decoder, row, 1) != 1) goto done;
    }
    jpeg_finish_decompress(&decoder);
    if (fwrite("SCJP", 1, 4, stdout) != 4 ||
        !write_u32((uint32_t)jpeg_length) || !write_u32(32 * 32 * 3) ||
        !write_u32(32) || !write_u32(32) || !write_u32((uint32_t)x) || !write_u32((uint32_t)y) ||
        fwrite(jpeg, 1, jpeg_length, stdout) != jpeg_length ||
        fwrite(decoded, 1, 32 * 32 * 3, stdout) != 32 * 32 * 3 || fflush(stdout) != 0) goto done;
    fprintf(stderr, "X11 实际帧已完成候选采集、tile 校验、JPEG 编码及 C 解码；只输出内存管道。\n");
    result = 0;
done:
    if (decoder_created) jpeg_destroy_decompress(&decoder);
    free(decoded);
    free(packet);
    free(tilebuffer);
    release_JPEG_buffer();
    g_tileInfo = NULL;
    free(desktop);
    if (attached) { XShmDetach(display, &shm); XSync(display, False); }
    if (image != NULL) XDestroyImage(image);
    if (shm.shmaddr != NULL) shmdt(shm.shmaddr);
    if (shm.shmid >= 0) shmctl(shm.shmid, IPC_RMID, NULL);
    if (display != NULL) XCloseDisplay(display);
    return result;
}
