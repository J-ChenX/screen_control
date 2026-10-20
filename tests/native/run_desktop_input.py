#!/usr/bin/env python3
"""提取实际 Linux 控制解析器，隔离验证分片、只读事件开关与帧坐标；不连接显示。"""
import argparse
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,required=True);args=parser.parse_args()
    source=args.source.resolve();text=(source/'meshcore/KVM/Linux/linux_kvm.c').read_text()
    start=text.index('int kvm_server_inputdata(char* block, int blocklen)\n{');end=text.index('\nint kvm_relay_feeddata',start);body=text[start:end]
    start=text.index('            ptr = 0;\n            while (ptr < len');end=text.index('            ptr = 0;',start+20)+len('            ptr = 0;');consume=text[start:end]
    template=r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
#include "meshcore/KVM/Linux/linux_tile.h"
int SCREEN_WIDTH=2560,SCREEN_HEIGHT=1440,TILE_WIDTH=32,slave2master[2]={0,1},COMPRESSION_QUALITY=85;
int g_enableEvents=1,g_shutdown=0,g_remotepause=0,remoteMouseX=0,remoteMouseY=0,FRAME_RATE_TIMER=40,SCALING_FACTOR_NEW=1024,COMPRESSION_RATIO=1,CURRENT_DISPLAY_ID=0,change_display=0;
int TILE_HEIGHT_COUNT=1,TILE_WIDTH_COUNT=1;
struct tileInfo_t tile={0};struct tileInfo_t *row=&tile;struct tileInfo_t **g_tileInfo=&row;
void *eventdisplay=NULL;FILE *logFile=NULL;
int mouse_calls=0,last_x=0,last_y=0,last_button=0;
void CheckDesktopSwitch(int value){(void)value;}
void KeyActionUnicode(int a,int b,void*d){(void)a;(void)b;(void)d;}
void KeyAction(int a,int b,void*d){(void)a;(void)b;(void)d;}
void MouseAction(int x,int y,int button,int wheel,void*d){(void)wheel;(void)d;mouse_calls++;last_x=x;last_y=y;last_button=button;}
void kvm_send_resolution(void){}
void kvm_send_display_list(void){}
void set_tile_compression(int a,int b){(void)a;COMPRESSION_QUALITY=b;}
void ILib_POSIX_CrashHandler(int code){exit(code);}
#define ILIBCRITICALEXIT(code) abort()
#include "meshcore/KVM/Linux/sc_adaptive_desktop.h"
/* INPUT */
static int ptr=0,ptr2=0,len=0;static char pchRequest2[30000];
static void consume(void){/* CONSUME */}
int main(void){
    sc_sequence=2;sc_epoch=2;sc_sent[1]=(ScSentFrame){1,1,1920,1080,2560,1440,sc_now_ms()};sc_sent[2]=(ScSentFrame){2,2,960,540,2560,1440,sc_now_ms()};
    unsigned char storage[32]={0},*mouse=storage+1;sc_u16(mouse,2);sc_u16(mouse+2,20);mouse[5]=2;
    sc_u16(mouse+6,960);sc_u16(mouse+8,540);sc_u32(mouse+12,1);sc_u32(mouse+16,1);
    assert(kvm_server_inputdata((char*)mouse,19)==0&&mouse_calls==0);
    assert(kvm_server_inputdata((char*)mouse,20)==20&&last_x==1280&&last_y==720);
    g_enableEvents=0;kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==1);g_enableEvents=1;
    unsigned char mixed[25]={0,8,0,5,1};memcpy(mixed+5,mouse,20);
    mouse_calls=0;for(unsigned i=0;i<25;i++){pchRequest2[len++]=mixed[i];consume();}
    assert(len==0&&mouse_calls==1&&last_x==1280&&g_remotepause==1);
    sc_u16(mouse+6,480);sc_u16(mouse+8,270);sc_u32(mouse+12,2);sc_u32(mouse+16,2);kvm_server_inputdata((char*)mouse,20);
    assert(last_x==1280&&last_y==720);
    sc_u32(mouse+16,100);mouse[5]=2;int count=mouse_calls;kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==count);
    mouse[5]=4;kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==count+1&&last_button==4);
    unsigned char bad[4]={0,2,0,0};assert(kvm_server_inputdata((char*)bad,4)==4&&g_shutdown==1);
    puts("实际控制解析器：逐字节分片、未对齐数据、事件拒绝、逐帧坐标及释放通过。");return 0;
}
'''
    env=os.environ.copy();env['CPATH']=str(source/'lib-jpeg-turbo/includes')+os.pathsep+env.get('CPATH','')
    with tempfile.TemporaryDirectory(prefix='screen-control-desktop-input-') as temporary:
        directory=Path(temporary);code=directory/'input.c';binary=directory/'input';code.write_text(template.replace('/* INPUT */',body).replace('/* CONSUME */',consume))
        subprocess.run(['cc','-std=gnu99','-D_POSIX','-DJPEGMAXBUF=0','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I.',str(code),str(ROOT/'target/release/libscreen_control_protocol_ffi.a'),'-ldl','-lpthread','-lm','-o',str(binary)],cwd=source,env=env,check=True)
        subprocess.run([str(binary)],env={**env,'ASAN_OPTIONS':'detect_leaks=1:halt_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'},check=True)

if __name__=='__main__':main()
