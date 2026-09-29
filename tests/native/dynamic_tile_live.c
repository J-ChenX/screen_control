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
#include <time.h>

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

static double now_ms(void)
{
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static void report_memory(int frame)
{
    FILE *stream = fopen("/proc/self/smaps_rollup", "r");
    if (stream == NULL) return;
    char line[256];
    unsigned long pss = 0, anonymous = 0;
    while (fgets(line, sizeof(line), stream) != NULL) {
        if (sscanf(line, "Pss: %lu kB", &pss) == 1) continue;
        (void)sscanf(line, "Anonymous: %lu kB", &anonymous);
    }
    fclose(stream);
    fprintf(stderr, "memory_frame=%d pss_kib=%lu anonymous_kib=%lu\n", frame, pss, anonymous);
}

static unsigned int read_u16(const unsigned char *bytes)
{
    return ((unsigned int)bytes[0] << 8) | bytes[1];
}

static uint32_t read_u32(const unsigned char *bytes)
{
    return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
           ((uint32_t)bytes[2] << 8) | bytes[3];
}

static int packet_has_dimensions(const void *packet, long long packet_size,
                                 int x, int y, int width, int height, int *jumbo)
{
    if (packet == NULL || packet_size <= 8 || packet_size > UINT32_MAX) return 0;
    const unsigned char *bytes = packet;
    size_t header = 8;
    *jumbo = 0;
    if (read_u16(bytes) == MNG_JUMBO) {
        if (packet_size <= 16 || read_u16(bytes + 2) != 8 ||
            read_u32(bytes + 4) != (uint32_t)packet_size - 8 ||
            read_u16(bytes + 8) != MNG_KVM_PICTURE ||
            read_u16(bytes + 12) != (unsigned int)x ||
            read_u16(bytes + 14) != (unsigned int)y) return 0;
        header = 16;
        *jumbo = 1;
    } else if (read_u16(bytes) != MNG_KVM_PICTURE ||
               read_u16(bytes + 2) != (unsigned int)packet_size ||
               read_u16(bytes + 4) != (unsigned int)x ||
               read_u16(bytes + 6) != (unsigned int)y) return 0;
    struct jpeg_decompress_struct decoder = {0};
    struct jpeg_error_mgr error;
    decoder.err = jpeg_std_error(&error);
    jpeg_create_decompress(&decoder);
    jpeg_mem_src(&decoder, bytes + header, (unsigned long)(packet_size - (long long)header));
    int valid = jpeg_read_header(&decoder, TRUE) == JPEG_HEADER_OK &&
                decoder.image_width == (unsigned int)width &&
                decoder.image_height == (unsigned int)height;
    jpeg_destroy_decompress(&decoder);
    return valid;
}

int main(int argc, char **argv)
{
    int complex_frame = argc == 3 && strcmp(argv[1], "complex-frame") == 0;
    int noise_frame = argc == 3 && strcmp(argv[1], "noise-frame") == 0;
    int full_frame = complex_frame || noise_frame || (argc == 3 && strcmp(argv[1], "full-frame") == 0);
    char *end = NULL;
    long frame_count = argc == 3 ? strtol(argv[2], &end, 10) : 0;
    if (argc != 3 || (!full_frame && strcmp(argv[1], "single-tile") != 0) ||
        end == argv[2] || *end != '\0' || frame_count < 60 || frame_count > 1800) return 2;
    int result = 1, attached = 0, pixel_changes = 0, packets = 0, jumbo_packets = 0;
    Display *display = XOpenDisplay(NULL);
    XImage *image = NULL;
    XShmSegmentInfo shm = {.shmid = -1, .shmaddr = NULL};
    struct tileInfo_t *tiles = NULL;
    struct tileInfo_t **rows = NULL;
    char *desktop = NULL;
    long long desktop_size = 0;
    unsigned long previous_pixel = 0;
    size_t encoded_bytes = 0;
    double capture_ms = 0, convert_ms = 0, encode_ms = 0;
    if (display == NULL || !XShmQueryExtension(display)) goto done;
    int screen = DefaultScreen(display);
    SCREEN_WIDTH = DisplayWidth(display, screen);
    SCREEN_HEIGHT = DisplayHeight(display, screen);
    if (!((SCREEN_WIDTH == 640 && SCREEN_HEIGHT == 480) ||
          (SCREEN_WIDTH == 3840 && SCREEN_HEIGHT == 2160)) ||
        (complex_frame && SCREEN_WIDTH != 640)) goto done;
    TILE_WIDTH_COUNT = full_frame ? (SCREEN_WIDTH + TILE_WIDTH - 1) / TILE_WIDTH : 1;
    TILE_HEIGHT_COUNT = full_frame ? (SCREEN_HEIGHT + TILE_HEIGHT - 1) / TILE_HEIGHT : 1;
    rows = calloc((size_t)TILE_HEIGHT_COUNT, sizeof(*rows));
    tiles = calloc((size_t)TILE_WIDTH_COUNT * (size_t)TILE_HEIGHT_COUNT, sizeof(*tiles));
    if (rows == NULL || tiles == NULL) goto done;
    for (int row = 0; row < TILE_HEIGHT_COUNT; row++) {
        rows[row] = tiles + (size_t)row * (size_t)TILE_WIDTH_COUNT;
        for (int col = 0; col < TILE_WIDTH_COUNT; col++) rows[row][col].crc = 0xff;
    }
    image = XShmCreateImage(display, DefaultVisual(display, screen),
                            DefaultDepth(display, screen), ZPixmap, NULL, &shm,
                            (unsigned int)SCREEN_WIDTH, (unsigned int)SCREEN_HEIGHT);
    if (image == NULL || image->bytes_per_line <= 0) goto done;
    size_t length = (size_t)image->bytes_per_line * (size_t)image->height;
    shm.shmid = shmget(IPC_PRIVATE, length, IPC_CREAT | 0600);
    if (shm.shmid < 0) goto done;
    shm.shmaddr = shmat(shm.shmid, NULL, 0);
    if (shm.shmaddr == (char *)-1) { shm.shmaddr = NULL; goto done; }
    image->data = shm.shmaddr;
    shm.readOnly = False;
    if (!XShmAttach(display, &shm)) goto done;
    attached = 1;
    XSync(display, False);
    g_tileInfo = rows;

    report_memory(0);
    for (int frame = 0; frame < frame_count; frame++) {
        double started = now_ms();
        if (!XShmGetImage(display, RootWindow(display, screen), image, 0, 0, AllPlanes)) goto done;
        capture_ms += now_ms() - started;
        if (noise_frame) {
            // 只改写本次采集的共享内存副本，制造每帧变化的高细节负载。
            uint32_t state = 0x9e3779b9U ^ (uint32_t)(frame + 1);
            unsigned char *pixels = (unsigned char *)image->data;
            for (size_t offset = 0; offset < length; offset++) {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                pixels[offset] = (unsigned char)(state >> 24);
            }
        }
        unsigned long pixel = XGetPixel(image, 80, 80);
        int changed = frame == 0 || pixel != previous_pixel;
        if (frame > 0 && changed) pixel_changes++;
        previous_pixel = pixel;

        started = now_ms();
        if (getScreenBuffer(&desktop, &desktop_size, image) != 0) goto done;
        convert_ms += now_ms() - started;
        for (int row = 0; row < TILE_HEIGHT_COUNT; row++)
            for (int col = 0; col < TILE_WIDTH_COUNT; col++) rows[row][col].flag = TILE_TODO;
        int frame_packets = 0;
        for (int row = 0; row < TILE_HEIGHT_COUNT; row++) {
            for (int col = 0; col < TILE_WIDTH_COUNT; col++) {
                if (rows[row][col].flag == TILE_SENT || rows[row][col].flag == TILE_DONT_SEND) continue;
                void *packet = NULL;
                long long packet_size = 0;
                int x = full_frame ? col * TILE_WIDTH : 64;
                int y = full_frame ? row * TILE_HEIGHT : 64;
                double tile_started = now_ms();
                int tile_result = getTileAt(x, y, &packet, &packet_size,
                                            desktop, desktop_size, row, col);
                encode_ms += now_ms() - tile_started;
                if (tile_result != 0) { free(packet); goto done; }
                if (packet != NULL) {
                    int jumbo = 0;
                    if (packet_size <= 0 || !packet_has_dimensions(packet, packet_size,
                                x, y,
                                full_frame ? SCREEN_WIDTH : TILE_WIDTH,
                                full_frame ? TILE_HEIGHT_COUNT * TILE_HEIGHT : TILE_HEIGHT, &jumbo)) {
                        free(packet);
                        goto done;
                    }
                    if ((complex_frame || noise_frame) && packets == 0 &&
                        (fwrite(packet, 1, (size_t)packet_size, stdout) != (size_t)packet_size ||
                         fflush(stdout) != 0)) {
                        free(packet);
                        goto done;
                    }
                    frame_packets++;
                    packets++;
                    jumbo_packets += jumbo;
                    encoded_bytes += (size_t)packet_size;
                }
                free(packet);
            }
        }
        if ((frame + 1) % 60 == 0) report_memory(frame + 1);
        if (frame_packets != changed) goto done;
        struct timespec pause = {.tv_sec = 0, .tv_nsec = 33000000};
        nanosleep(&pause, NULL);
    }
    fprintf(stderr, "mode=%s screen=%dx%d frames=%ld pixel_changes=%d packets=%d jumbo_packets=%d encoded_bytes=%zu "
            "capture_ms=%.3f convert_ms=%.3f tile_encode_ms=%.3f\n",
            complex_frame ? "complex-frame" : noise_frame ? "noise-frame" :
            full_frame ? "full-frame" : "single-tile",
            SCREEN_WIDTH, SCREEN_HEIGHT, frame_count, pixel_changes, packets, jumbo_packets, encoded_bytes,
            capture_ms / frame_count, convert_ms / frame_count, encode_ms / frame_count);
    result = pixel_changes >= 5 && packets == pixel_changes + 1 &&
             (!complex_frame || jumbo_packets >= 5) ? 0 : 1;
done:
    free(desktop);
    free(tilebuffer);
    release_JPEG_buffer();
    g_tileInfo = NULL;
    free(rows);
    free(tiles);
    if (attached) { XShmDetach(display, &shm); XSync(display, False); }
    if (image != NULL) XDestroyImage(image);
    if (shm.shmaddr != NULL) shmdt(shm.shmaddr);
    if (shm.shmid >= 0) shmctl(shm.shmid, IPC_RMID, NULL);
    if (display != NULL) XCloseDisplay(display);
    report_memory(-1);
    return result;
}
