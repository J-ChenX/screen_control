#!/usr/bin/env python3
"""提取 Windows 实际控制解析器与适配层，隔离验证队列、反馈、选屏及鼠标映射。"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    text = (source / 'meshcore/KVM/Windows/kvm.c').read_text()
    start = text.index('int kvm_server_inputdata(char *block, int blocklen, ILibKVM_WriteHandler writeHandler, void *reserved)\n{')
    end = text.index('\ntypedef struct kvm_data_handler', start)
    body = text[start:end]
    service = (source / 'meshservice/ServiceMain.c').read_text()
    start = service.index('ILibTransport_DoneState kvm_serviceWriteSink(')
    sink = service[start:service.index('BOOL CtrlHandler(', start)]
    template = r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
#define TRUE 1
#define KVMDEBUG(...)
#define ILibRemoteLogging_printf(...)
typedef enum { ILibTransport_DoneState_ERROR=-4, ILibTransport_DoneState_INCOMPLETE=0, ILibTransport_DoneState_COMPLETE=1 } ILibTransport_DoneState;
typedef ILibTransport_DoneState (*ILibKVM_WriteHandler)(char *, int, void *);
typedef struct { unsigned int LowPart, HighPart; } LARGE_INTEGER;
typedef unsigned int DWORD;
#define STD_OUTPUT_HANDLE -11
int GetStdHandle(int n){return n;}
static int write_mode=0,write_calls=0,write_total=0;
int WriteFile(int handle,char *data,DWORD length,DWORD *written,void *reserved){
    (void)handle;(void)data;(void)reserved;write_calls++;
    if(write_mode==1&&write_calls==2)return 0;
    if(write_mode==2){*written=0;return 1;}
    if(write_mode==3){*written=length+1;return 1;}
    *written=length>3?3:length;write_total+=(int)*written;return 1;
}
/* SINK */
typedef pthread_mutex_t SRWLOCK;
#define SRWLOCK_INIT PTHREAD_MUTEX_INITIALIZER
#define AcquireSRWLockExclusive(p) pthread_mutex_lock(p)
#define ReleaseSRWLockExclusive(p) pthread_mutex_unlock(p)
static uint64_t now=10000;
uint64_t GetTickCount64(void){return now;}
int QueryPerformanceCounter(LARGE_INTEGER *v){v->LowPart=(unsigned int)now;v->HighPart=1;return 1;}
unsigned int GetCurrentProcessId(void){return 31;}
int SCREEN_WIDTH=3840,SCREEN_HEIGHT=2160,TILE_WIDTH=32,PIXEL_SIZE=4;
int SCREEN_X=-3840,SCREEN_Y=0,VSCREEN_X=-3840,VSCREEN_Y=0,VSCREEN_WIDTH=7680,VSCREEN_HEIGHT=2160;
int SCREEN_SEL=1,SCREEN_SEL_TARGET=1,SCALING_FACTOR=1024,SCALING_FACTOR_NEW=1024;
int FRAME_RATE_TIMER=40,g_shutdown=0,g_pause=0,g_remotepause=0,g_blockinput=0,gRemoteMouseMoved=0;
int mouse_calls=0,last_x=0,last_y=0,last_button=0;
void MouseAction(int x,int y,int button,int wheel){(void)wheel;last_x=x;last_y=y;last_button=button;mouse_calls++;}
void CheckDesktopSwitch(int value,ILibKVM_WriteHandler w,void *r){(void)value;(void)w;(void)r;}
void KeyAction(int a,int b){(void)a;(void)b;}
void KeyActionUnicode(int a,int b){(void)a;(void)b;}
void BlockInput(int value){(void)value;}
int TouchInit(void){return 0;}
int TouchAction1(int a,unsigned int b,unsigned short c,unsigned short d){(void)a;(void)b;(void)c;(void)d;return 0;}
int TouchAction2(char *a,int b,int c){(void)a;(void)b;(void)c;return 0;}
void kvm_send_display_list(ILibKVM_WriteHandler w,void *r){(void)w;(void)r;}
int sc_windows_encode(const unsigned char *s,unsigned int w,unsigned int h,int q,unsigned char **o,size_t *n){(void)s;(void)w;(void)h;(void)q;(void)o;(void)n;return 0;}
int kvm_server_inputdata(char *,int,ILibKVM_WriteHandler,void *);
#include "meshcore/KVM/Windows/sc_windows_adaptive_desktop.h"
static int sc_last_mouse_x=0,sc_last_mouse_y=0;
/* INPUT */
static ILibTransport_DoneState output(char *p,int n,void *r){(void)p;(void)n;(void)r;return ILibTransport_DoneState_COMPLETE;}
static void receive(const unsigned char *p,size_t n){assert(sc_queue_input((const char*)p,(int)n)==(int)n);sc_drain_input();}
int main(void){
    for(write_mode=0;write_mode<4;write_mode++){
        char payload[10]={0};write_calls=write_total=0;
        ILibTransport_DoneState result=kvm_serviceWriteSink(payload,10,NULL);
        if(write_mode==0)assert(result==ILibTransport_DoneState_COMPLETE&&write_total==10&&write_calls==4);
        else assert(result==ILibTransport_DoneState_ERROR);
    }
    assert(kvm_serviceWriteSink(NULL,1,NULL)==ILibTransport_DoneState_ERROR);
    sc_writer=output;sc_writer_reserved=NULL;sc_reset_session();
    unsigned char storage[32]={0},*mouse=storage+1;
    sc_u16(mouse,2);sc_u16(mouse+2,20);mouse[5]=2;
    sc_sequence=1;sc_sent[1]=(ScSentFrame){7,1,1920,1080,3840,2160,now,sc_display_generation};
    sc_u16(mouse+6,960);sc_u16(mouse+8,540);sc_u32(mouse+12,7);sc_u32(mouse+16,1);
    for(int i=0;i<19;i++){receive(mouse+i,1);assert(mouse_calls==0);}
    receive(mouse+19,1);assert(mouse_calls==1&&last_x==16383&&last_y==32767&&sc_control_used==0);
    unsigned char pause[5]={0,8,0,5,1};receive(pause,5);assert(g_remotepause);
    unsigned char ack[12]={127,1,0,12};sc_u32(ack+4,7);sc_u32(ack+8,1);
    sc_sequence=2;sc_sent[2]=(ScSentFrame){7,2,960,540,3840,2160,now-2100,sc_display_generation};sc_sent[1].sent_at=now-2100;
    sc_feedback=sc_delta=1;sc_feedback_at=now-2100;sc_acknowledged=0;
    assert(sc_waiting_for_feedback(0));receive(ack,5);assert(sc_acknowledged==0);receive(ack+5,7);
    assert(sc_acknowledged==1&&!sc_waiting_for_feedback(1)&&sc_delta&&!sc_delta_blocked);
    pause[4]=0;receive(pause,5);assert(!g_remotepause);
    unsigned char display[6]={0,12,0,6,0,2};receive(display,6);assert(SCREEN_SEL_TARGET==2);
    int calls=mouse_calls;receive(mouse,20);assert(mouse_calls==calls);
    mouse[5]=4;receive(mouse,20);assert(mouse_calls==calls+1&&last_x==16383&&last_y==32767);
    SCREEN_SEL=2;sc_sequence=2;sc_sent[2]=(ScSentFrame){8,2,960,540,3840,2160,now,sc_display_generation};
    sc_u32(mouse+12,8);sc_u32(mouse+16,2);sc_u16(mouse+6,480);sc_u16(mouse+8,270);mouse[5]=2;receive(mouse,20);
    assert(last_x==16383&&last_y==32767);
    SCREEN_X=0;receive(mouse,20);assert(last_x==49151); /* 有符号虚拟桌面原点。 */
    sc_u16(mouse+6,961);calls=mouse_calls;receive(mouse,20);assert(mouse_calls==calls);
    unsigned char compression[10]={0,5,0,10,130,90,5,160,0,40};receive(compression,10);assert(sc_delta&&sc_feedback);
    unsigned char reset[4]={127,5,0,4};receive(reset,4);assert(sc_delta);
    unsigned char refresh[4]={0,6,0,4};receive(refresh,4);assert(!sc_delta&&sc_delta_blocked);
    receive(compression,10);assert(!sc_delta&&sc_feedback);
    sc_delta_blocked=0;sc_delta=1;sc_acknowledged=0;sc_feedback_at=now-2100;sc_sent[1].sent_at=sc_sent[2].sent_at=now-2100;
    assert(!sc_waiting_for_feedback(1)&&!sc_delta&&sc_delta_blocked);
    /* 合法大包跨残余容量边界，后面的完整 ACK 必须在超时前消费。 */
    sc_control_used=sc_control_length=0;sc_delta_blocked=0;sc_delta=sc_feedback=1;
    sc_sequence=2;sc_acknowledged=0;sc_feedback_at=now-2100;
    unsigned char *large=calloc(1,65547);assert(large);sc_u16(large,0x7777);sc_u16(large+2,65535);
    memcpy(large+65535,ack,12);sc_sent[1].epoch=7;sc_sent[1].sequence=1;
    receive(large,65530);assert(sc_control_used==65530);
    receive(large+65530,17);assert(sc_control_used==0&&sc_control_length==0&&sc_acknowledged==1);
    assert(!sc_waiting_for_feedback(1)&&sc_delta&&!sc_delta_blocked);free(large);
    unsigned char invalid[4]={0,2,0,0};receive(invalid,4);assert(g_shutdown);
    g_shutdown=0;sc_control_used=0;unsigned char *full=calloc(1,SC_CONTROL_CAPACITY);assert(full);
    assert(sc_queue_input((char*)full,SC_CONTROL_CAPACITY)==SC_CONTROL_CAPACITY);
    assert(!sc_queue_input((char*)full,1)&&g_shutdown);free(full);
    sc_release_desktop();puts("Windows 实际控制解析器：分片/未对齐、双帧信用、排队反馈、暂停、切屏、逐帧坐标及安全释放通过。");
    return 0;
}
'''
    with tempfile.TemporaryDirectory(prefix='screen-control-windows-input-') as directory:
        work = Path(directory)
        code = work / 'input.c'
        binary = work / 'input'
        code.write_text(template.replace('/* INPUT */', body).replace('/* SINK */', sink))
        subprocess.run(['cc', '-std=gnu99', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections',
                        '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie', '-I.',
                        str(code), str(ROOT / 'target/release/libscreen_control_protocol_ffi.a'),
                        '-ldl', '-lpthread', '-lm', '-o', str(binary)], cwd=source, check=True)
        subprocess.run([str(binary)], env={**os.environ, 'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
                                          'UBSAN_OPTIONS': 'halt_on_error=1'}, check=True)


if __name__ == '__main__':
    main()
