#include "screen_control_protocol.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xfixes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// 只读取真实光标像素；参考实现不调用 Rust，逐像素核对叠加及裁剪结果。
static size_t reference_overlay(uint8_t *frame, const unsigned long *pixels, ScCursorMeta meta)
{
    size_t changed = 0;
    for (uint32_t row = 0; row < meta.cursor_height; row++) {
        int64_t y = (int64_t)meta.origin_y + row;
        if (y < 0 || y >= meta.height) continue;
        for (uint32_t col = 0; col < meta.cursor_width; col++) {
            int64_t x = (int64_t)meta.origin_x + col;
            if (x < 0 || x >= meta.width) continue;
            uint32_t argb = (uint32_t)pixels[(size_t)row * meta.cursor_width + col];
            if ((argb >> 24) <= 128) continue;
            size_t target = ((size_t)y * meta.stride_pixels + (size_t)x) * 3;
            for (size_t channel = 0; channel < 3; channel++) frame[target + channel] = 255 - frame[target + channel];
            changed++;
        }
    }
    return changed;
}

static int check_image(const XFixesCursorImage *image, size_t *changed_total)
{
    if (image == NULL || image->pixels == NULL || image->width == 0 || image->height == 0 ||
        image->width > 1024 || image->height > 1024) return 0;
    uint32_t width = image->width + 16 < 128 ? 128 : image->width + 16;
    uint32_t height = image->height + 16 < 128 ? 128 : image->height + 16;
    size_t frame_len = (size_t)width * height * 3;
    size_t cursor_len = (size_t)image->width * image->height * sizeof(unsigned long);
    uint8_t *frame = malloc(frame_len), *expected = malloc(frame_len), *original = malloc(frame_len);
    if (frame == NULL || expected == NULL || original == NULL) {
        free(frame); free(expected); free(original); return 0;
    }
    ScCursorMeta meta = {width, width, height, image->width, image->height,
                         sizeof(unsigned long), 0, 0};
    int32_t origins[3][2] = {{8, 8}, {-(int32_t)image->width / 2, -(int32_t)image->height / 2},
                             {(int32_t)width - 1, (int32_t)height - 1}};
    int result = 1;
    for (size_t mode = 0; mode < 3; mode++) {
        for (size_t i = 0; i < frame_len; i++) original[i] = (uint8_t)(i % 251);
        memcpy(frame, original, frame_len);
        memcpy(expected, original, frame_len);
        meta.origin_x = origins[mode][0]; meta.origin_y = origins[mode][1];
        *changed_total += reference_overlay(expected, image->pixels, meta);
        if (sc_cursor_overlay_rgb24(frame, frame_len, (const uint8_t *)image->pixels, cursor_len, meta) != 1 ||
            memcmp(frame, expected, frame_len) != 0) { result = 0; break; }
        memcpy(frame, original, frame_len);
        if (sc_cursor_overlay_rgb24(frame, frame_len, (const uint8_t *)image->pixels, cursor_len - 1, meta) != 0 ||
            memcmp(frame, original, frame_len) != 0) { result = 0; break; }
        if (sc_cursor_overlay_rgb24(frame, frame_len - 1, (const uint8_t *)image->pixels, cursor_len, meta) != 0 ||
            memcmp(frame, original, frame_len) != 0) { result = 0; break; }
    }
    free(frame); free(expected); free(original);
    return result;
}

int main(void)
{
    Display *display = XOpenDisplay(NULL);
    if (display == NULL) { fputs("真实 X11 显示不可用\n", stderr); return 1; }
    int event_base, error_base;
    if (!XFixesQueryExtension(display, &event_base, &error_base)) {
        fputs("XFixes 扩展不可用\n", stderr); XCloseDisplay(display); return 1;
    }
    size_t changed = 0;
    int result = 0;
    for (int round = 0; round < 16; round++) {
        XFixesCursorImage *image = XFixesGetCursorImage(display);
        int okay = check_image(image, &changed);
        if (image != NULL) XFree(image);
        if (!okay) { result = 1; break; }
    }
    XCloseDisplay(display);
    if (result || changed == 0) {
        fputs("真实光标裁剪或短输入对照失败\n", stderr);
        return 1;
    }
    printf("真实 XFixes 光标经 Rust C ABI 完成 16 轮、每轮三处裁剪及短输入拒绝；可见像素 %zu 个。\n", changed);
    return 0;
}
