#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xlib.h>

int SCREEN_WIDTH = 7;
int SCREEN_HEIGHT = 2;
int TILE_WIDTH = 4;

int get_tile_buffer(int x, int y, void **buffer, long long bufferSize,
                    void *desktop, long long desktopsize, int tilewidth, int tileheight);
int util_crc(int x, int y, void *desktop, long long desktopsize,
             int tilewidth, int tileheight, int *result);
int getScreenBuffer(char **desktop, long long *desktopsize, XImage *image);

int main(void)
{
    unsigned char desktop[48];
    unsigned char target[16];
    for (unsigned int i = 0; i < sizeof(desktop); ++i) desktop[i] = (unsigned char)i;
    memset(target, 0xa5, sizeof(target));
    void *buffer = target;
    assert(get_tile_buffer(2, 0, &buffer, sizeof(target), desktop, sizeof(desktop), 2, 2) == 0);
    assert(memcmp(target, desktop + 6, 6) == 0);
    assert(memcmp(target + 6, desktop + 30, 6) == 0);
    assert(target[12] == 0xa5);
    memset(target, 0xa5, sizeof(target));
    assert(get_tile_buffer(2, 0, &buffer, sizeof(target), desktop, 35, 2, 2) != 0);
    assert(target[0] == 0xa5);
    assert(get_tile_buffer(7, 0, &buffer, sizeof(target), desktop, sizeof(desktop), 2, 2) != 0);
    assert(target[0] == 0xa5);
    int checksum = 0;
    assert(util_crc(4, 1, desktop, sizeof(desktop), 4, 1, &checksum) == 0);
    int original_checksum = checksum;
    desktop[47] ^= 0x80;
    assert(util_crc(4, 1, desktop, sizeof(desktop), 4, 1, &checksum) == 0);
    assert(checksum != original_checksum);
    desktop[47] ^= 0x80;
    checksum = 123;
    assert(util_crc(4, 1, desktop, sizeof(desktop) - 1, 4, 1, &checksum) != 0);
    assert(checksum == 123);

    SCREEN_WIDTH = 2;
    unsigned char pixels[16] = {3, 2, 1, 6, 5, 4, 0xee, 0xee,
                                9, 8, 7, 12, 11, 10, 0xee, 0xee};
    XImage image = {0};
    image.width = 2;
    image.height = 2;
    image.bits_per_pixel = 24;
    image.bytes_per_line = 8;
    image.byte_order = LSBFirst;
    image.red_mask = 0xff0000;
    image.green_mask = 0xff00;
    image.blue_mask = 0xff;
    image.data = (char *)pixels;
    char *converted = NULL;
    long long converted_size = 0;
    assert(getScreenBuffer(&converted, &converted_size, &image) == 0);
    assert(converted_size == 48);
    assert(memcmp(converted, (unsigned char[]){1, 2, 3, 4, 5, 6}, 6) == 0);
    assert(memcmp(converted + 12, (unsigned char[]){7, 8, 9, 10, 11, 12}, 6) == 0);
    for (int i = 6; i < 12; ++i) assert(converted[i] == 0);
    for (int i = 24; i < 48; ++i) assert(converted[i] == 0);
    image.bytes_per_line = 5;
    assert(getScreenBuffer(&converted, &converted_size, &image) != 0);
    free(converted);
    return 0;
}
