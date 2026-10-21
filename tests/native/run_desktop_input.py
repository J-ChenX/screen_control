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
    poll_start=text.index('\t\tFD_ZERO(&readset);',text.index('while (!g_shutdown)'))
    poll=text[poll_start:text.index('        if (sc_now_ms() < sc_next_capture)',poll_start)]
    template=r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/select.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
#include "meshcore/KVM/Linux/linux_tile.h"
int SCREEN_WIDTH=2560,SCREEN_HEIGHT=1440,TILE_WIDTH=32,slave2master[2]={0,1},COMPRESSION_QUALITY=85;
int master2slave[2],g_pause=0;static uint64_t sc_next_capture=0;
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

/* 使用真实主循环控制片段，验证已排队 ACK 必须先于超时回退。 */
static int feedback_poll(void){
    struct timeval tv;fd_set readset,errorset,writeset;ssize_t cbBytesRead;
    do {
        /* POLL */
        return 1;
    }while(0);
    return 0;
}
static void feedback_cases(void){
    for(int scenario=0;scenario<8;scenario++){
        assert(pipe(master2slave)==0);
        sc_sequence=2;sc_acknowledged=0;sc_epoch=7;sc_feedback=sc_delta=1;sc_delta_blocked=0;
        g_shutdown=g_remotepause=g_pause=ptr=len=0;sc_next_capture=0;
        sc_feedback_at=sc_now_ms()-((scenario==2||scenario==7)?0:2100);
        sc_sent[1]=(ScSentFrame){.epoch=7,.sequence=1,.sent_at=sc_feedback_at};
        sc_sent[2]=(ScSentFrame){.epoch=7,.sequence=2,.sent_at=sc_feedback_at};
        unsigned char ack[12]={0x7f,1,0,12};sc_u32(ack+4,7);sc_u32(ack+8,1);
        if(scenario==0||scenario==4)assert(write(master2slave[1],ack,12)==12);
        if(scenario==3||scenario==4||scenario==6)g_remotepause=1;
        if(scenario==5){close(master2slave[1]);master2slave[1]=-1;}
        if(scenario==6){unsigned char resume[5]={0,8,0,5,0};assert(write(master2slave[1],resume,5)==5);}
        if(scenario==7)assert(write(master2slave[1],ack,5)==5);
        int capture=feedback_poll();
        if(scenario==0)assert(capture&&sc_acknowledged==1&&sc_feedback&&sc_delta&&!sc_delta_blocked);
        if(scenario==1||scenario==6)assert(capture&&!sc_feedback&&!sc_delta&&sc_delta_blocked&&sc_force&&!g_remotepause);
        if(scenario==2||scenario==3)assert(!capture&&sc_feedback&&sc_delta&&!sc_delta_blocked);
        if(scenario==4)assert(!capture&&sc_acknowledged==1&&sc_delta&&!sc_delta_blocked);
        if(scenario==5)assert(!capture&&g_shutdown);
        if(scenario==7){
            assert(!capture&&len==5&&sc_acknowledged==0&&sc_delta);
            assert(write(master2slave[1],ack+5,7)==7);capture=feedback_poll();
            assert(capture&&len==0&&sc_acknowledged==1&&sc_delta&&!sc_delta_blocked);
        }
        close(master2slave[0]);if(master2slave[1]>=0)close(master2slave[1]);
    }
    puts("实际控制循环：排队/分片反馈、真实超时、暂停、恢复与 EOF 通过。");
}

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
    for(unsigned i=0;i<3;i++){
        unsigned char release=(unsigned char)(4u<<(i*2));mouse[5]=release;
        g_enableEvents=0;kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==count);g_enableEvents=1;
        kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==++count&&last_button==release&&last_x==remoteMouseX&&last_y==remoteMouseY);
    }
    for(unsigned i=0;i<5;i++){
        unsigned char denied[]={0,2,8,32,136};mouse[5]=denied[i];kvm_server_inputdata((char*)mouse,20);assert(mouse_calls==count);
    }
    unsigned char bad[4]={0,2,0,0};assert(kvm_server_inputdata((char*)bad,4)==4&&g_shutdown==1);
    sc_acknowledged=2;sc_force=0;unsigned char discard[12]={0x7f,3,0,12};sc_u32(discard+4,1);sc_u32(discard+8,1);
    kvm_server_inputdata((char*)discard,12);assert(sc_force==1&&sc_acknowledged==2);
    sc_acknowledged=0;unsigned char display[6]={0,12,0,6,0,1};kvm_server_inputdata((char*)display,6);
    assert(sc_frame_input_axis(2,2,0,0)==-1); /* 切屏旧画面不能输入，但真实反馈仍归还信用。 */
    unsigned char confirmed[12]={0x7f,1,0,12};sc_u32(confirmed+4,2);sc_u32(confirmed+8,2);
    kvm_server_inputdata((char*)confirmed,12);assert(sc_acknowledged==2);
    unsigned char compression[10]={0,5,0,10,130,90,5,160,0,40};
    kvm_server_inputdata((char*)compression,10);assert(sc_delta==1&&sc_feedback==1&&sc_force==1);
    sc_force=0;unsigned char reset[4]={0x7f,5,0,4};kvm_server_inputdata((char*)reset,4);assert(sc_delta==1&&sc_force==1);
    compression[4]=129;kvm_server_inputdata((char*)compression,10);assert(sc_delta==0&&sc_delta_blocked==1);
    compression[4]=130;kvm_server_inputdata((char*)compression,10);assert(sc_delta==0); /* 旧查看者触发回退后不得重新争抢。 */
    sc_delta_blocked=0;kvm_server_inputdata((char*)compression,10);assert(sc_delta==1);
    unsigned char refresh[4]={0,6,0,4};kvm_server_inputdata((char*)refresh,4);assert(sc_delta==0&&sc_delta_blocked==1);
    sc_delta_blocked=0;sc_delta=1;sc_feedback=1;sc_sequence=10;sc_acknowledged=8;sc_feedback_at=sc_now_ms()-2100;
    assert(!sc_waiting_for_feedback(1)&&sc_delta==0&&sc_delta_blocked==1&&sc_force==1);
    feedback_cases();
    puts("实际控制解析器：逐字节分片、未对齐数据、事件拒绝、逐帧坐标及释放通过。");return 0;
}
'''
    env=os.environ.copy();env['CPATH']=str(source/'lib-jpeg-turbo/includes')+os.pathsep+env.get('CPATH','')
    with tempfile.TemporaryDirectory(prefix='screen-control-desktop-input-') as temporary:
        directory=Path(temporary);code=directory/'input.c';binary=directory/'input';code.write_text(template.replace('/* INPUT */',body).replace('/* CONSUME */',consume).replace('/* POLL */',poll))
        subprocess.run(['cc','-std=gnu99','-D_POSIX','-DJPEGMAXBUF=0','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I.',str(code),str(ROOT/'target/release/libscreen_control_protocol_ffi.a'),'-ldl','-lpthread','-lm','-o',str(binary)],cwd=source,env=env,check=True)
        subprocess.run([str(binary)],env={**env,'ASAN_OPTIONS':'detect_leaks=1:halt_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'},check=True)

if __name__=='__main__':main()
