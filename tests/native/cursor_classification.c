#include <X11/extensions/Xfixes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

extern void *x11_exports;
extern void *xfixes_exports;
extern int kvm_fetch_currentCursor(Display *display);

static int image_mode;
static int freed_images;
static int checked_alpha;

static int fake_xfree(void *image)
{
	++freed_images;
	free(image);
	return 0;
}

static void *fake_get_image(Display *display)
{
	XFixesCursorImage *image;
	size_t count;
	if (display == NULL || image_mode == 0) return NULL;
	count = image_mode == 1 ? 64 : 1;
	image = calloc(1, sizeof(*image) + count * sizeof(unsigned long));
	if (image == NULL) return NULL;
	image->pixels = (unsigned long *)(image + 1);
	if (image_mode == 1)
	{
		image->width = 8;
		image->height = 8;
		for (size_t i = 0; i < count; ++i) image->pixels[i] = (unsigned long)i << 24;
	}
	else if (image_mode == 2)
	{
		image->width = 65535;
		image->height = 65535;
	}
	else
	{
		image->width = 8;
		image->height = 8;
		image->pixels = NULL;
	}
	return image;
}

uint32_t crc32c(uint32_t crc, const unsigned char *alpha, uint32_t length)
{
	if (crc != 0 || length != 58) return 0;
	for (uint32_t i = 0; i < length; ++i)
	{
		if (alpha[i] != i + 6) return 0;
	}
	++checked_alpha;
	return 2788757291U;
}

static int check(int condition, const char *label)
{
	if (condition) return 0;
	fprintf(stderr, "cursor classification failed: %s\n", label);
	return 1;
}

int main(void)
{
	void *x11_functions[30] = {0};
	void *xfixes_functions[5] = {0};
	int failed = 0;
	x11_functions[12] = (void *)fake_xfree;
	xfixes_functions[3] = (void *)fake_get_image;
	x11_exports = x11_functions;
	xfixes_exports = xfixes_functions;
	failed |= check(kvm_fetch_currentCursor(NULL) == 4, "null display");
	xfixes_functions[3] = NULL;
	failed |= check(kvm_fetch_currentCursor((Display *)1) == 4, "missing XFixes function");
	xfixes_functions[3] = (void *)fake_get_image;
	image_mode = 0;
	failed |= check(kvm_fetch_currentCursor((Display *)1) == 4 && freed_images == 0, "null image");
	image_mode = 1;
	failed |= check(kvm_fetch_currentCursor((Display *)1) == 9 && checked_alpha == 1 && freed_images == 1,
		"valid image and alpha");
	image_mode = 2;
	failed |= check(kvm_fetch_currentCursor((Display *)1) == 4 && freed_images == 2,
		"oversized image without pixel read");
	image_mode = 3;
	failed |= check(kvm_fetch_currentCursor((Display *)1) == 4 && freed_images == 3,
		"missing pixels");
	return failed;
}
