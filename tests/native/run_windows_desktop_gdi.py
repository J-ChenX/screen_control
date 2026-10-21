#!/usr/bin/env python3
"""从固定 Windows 候选提取实际采集和编码函数，准备 MSVC 原生检查源码。"""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]


def function(text, signature):
    start = text.index(signature)
    body = text.index('{', start)
    depth = 1
    end = body + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    text = (args.source / 'meshcore/KVM/Windows/tile.cpp').read_text()
    signatures = ['extern "C" int sc_windows_reset_capture(', 'extern "C" int sc_windows_encode(',
                  'int GetEncoderClsid(', 'int adjust_screen_size(', 'int get_desktop_buffer(']
    code = '''#include <windows.h>
#include <gdiplus.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <io.h>
using namespace Gdiplus;
extern "C" {extern int TILE_WIDTH,SCREEN_WIDTH,SCREEN_HEIGHT,SCALED_WIDTH,SCALED_HEIGHT,SCREEN_X,SCREEN_Y,SCALING_FACTOR,PIXEL_SIZE;
void ILibCriticalLog(void*,const char*,int,int,int) {abort();}}
#define KVMDEBUG(...)
HDC hDesktopDC=NULL,hCaptureDC=NULL; HBITMAP hCapturedBitmap=NULL;HGDIOBJ hCaptureOriginal=NULL;CLSID encoderClsid;ULONG_PTR token;
'''
    for signature in signatures:
        body = function(text, signature)
        if signature == 'int get_desktop_buffer(':
            body = 'extern "C" ' + body
        code += body + '\n'
    code += '''extern "C" int test_init(void){GdiplusStartupInput input;return GdiplusStartup(&token,&input,NULL)==Ok&&GetEncoderClsid(L"image/jpeg",&encoderClsid)>=0;}
extern "C" void test_finish(void){if(hCaptureDC)SelectObject(hCaptureDC,hCaptureOriginal);if(hCapturedBitmap)DeleteObject(hCapturedBitmap);if(hCaptureDC)DeleteDC(hCaptureDC);if(hDesktopDC)ReleaseDC(NULL,hDesktopDC);GdiplusShutdown(token);}
extern "C" int test_decode(const unsigned char*p,size_t n,unsigned char**out,unsigned*w,unsigned*h){
 IStream*s=NULL;if(CreateStreamOnHGlobal(NULL,TRUE,&s)!=S_OK)return 0;ULONG used; s->Write(p,(ULONG)n,&used);LARGE_INTEGER zero={};s->Seek(zero,STREAM_SEEK_SET,NULL);
 int ok=0;{Bitmap b(s);if(b.GetLastStatus()==Ok){*w=b.GetWidth();*h=b.GetHeight();Rect rect(0,0,*w,*h);BitmapData d={};
 if(b.LockBits(&rect,ImageLockModeRead,PixelFormat24bppRGB,&d)==Ok){*out=(unsigned char*)malloc((size_t)*w**h*3);if(*out){for(unsigned y=0;y<*h;y++)for(unsigned x=0;x<*w;x++)for(unsigned c=0;c<3;c++)(*out)[((size_t)y**w+x)*3+c]=((unsigned char*)d.Scan0)[(ptrdiff_t)y*d.Stride+x*3+2-c];ok=1;}b.UnlockBits(&d);}}}s->Release();return ok;}
'''
    (args.output / 'gdi.cpp').write_text(code)
    shutil.copyfile(ROOT / 'tests/native/windows_desktop_gdi.c', args.output / 'main.c')
    # stdout 二进制模式只用于可选浏览器驱动。
    p = args.output / 'main.c'
    p.write_text(p.read_text().replace('#include <windows.h>', '#include <windows.h>\n#include <io.h>'))


if __name__ == '__main__':
    main()
