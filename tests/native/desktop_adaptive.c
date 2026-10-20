#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>
#include <errno.h>
#include <jpeglib.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
int SCREEN_WIDTH=2560,SCREEN_HEIGHT=1440,TILE_WIDTH=32,slave2master[2]={0,1},COMPRESSION_QUALITY=90;
static unsigned char *wire;static size_t wire_length;static int interrupt_once,emit_wire;
int ILibMemory_Copy_s(void *d,size_t cap,void *s,size_t n){assert(n<=cap);memcpy(d,s,n);return 0;}
void ILib_POSIX_CrashHandler(int code){exit(code);}
void kvm_send_resolution(void){}
static ssize_t test_write(int fd,const void *bytes,size_t n){
    (void)fd;if(interrupt_once){interrupt_once=0;errno=EINTR;return -1;}
    size_t count=n>137?137:n;assert(wire_length+count<16*1024*1024);memcpy(wire+wire_length,bytes,count);wire_length+=count;return (ssize_t)count;
}
#define write test_write
#include "meshcore/KVM/Linux/sc_adaptive_desktop.h"
#undef write
static unsigned int read16(const unsigned char *p){return p[0]*256u+p[1];}
static void verify_frame(unsigned int width,unsigned int height){
    assert(wire_length>56&&read16(wire)==SC_FRAME_METADATA&&read16(wire+2)==40);
    assert(read16(wire+20)==width&&read16(wire+22)==height);
    const unsigned char *packet=wire+40;size_t offset=read16(packet)==MNG_JUMBO?16:8;
    assert(read16(packet+(offset==16?8:0))==MNG_KVM_PICTURE);
    struct jpeg_decompress_struct d={0};struct jpeg_error_mgr e;d.err=jpeg_std_error(&e);jpeg_create_decompress(&d);
    jpeg_mem_src(&d,packet+offset,(unsigned long)(wire_length-40-offset));assert(jpeg_read_header(&d,1)==JPEG_HEADER_OK);
    assert(d.image_width==width&&d.image_height==height);jpeg_start_decompress(&d);unsigned char *row=malloc(width*3);assert(row);
    unsigned long long error=0,channels=0;
    while(d.output_scanline<height){unsigned y=d.output_scanline;JSAMPROW rows[1]={row};assert(jpeg_read_scanlines(&d,rows,1)==1);
        for(unsigned x=0;x<width*3;x++){error+=(unsigned long long)abs((int)row[x]-(int)sc_scaled[(size_t)y*width*3+x]);channels++;}}
    jpeg_finish_decompress(&d);jpeg_destroy_decompress(&d);free(row);assert((double)error/channels<15);
    if(emit_wire){unsigned char length[4];sc_u32(length,(unsigned int)wire_length);assert(fwrite(length,1,4,stdout)==4);assert(fwrite(wire,1,wire_length,stdout)==wire_length);}
    fprintf(emit_wire?stderr:stdout,"tier=%u size=%ux%u bytes=%zu mean_error=%.3f\n",sc_tier,width,height,wire_length,(double)error/channels);
}
int main(int argc,char **argv){
    emit_wire=argc==2&&strcmp(argv[1],"--wire")==0;
    wire=malloc(16*1024*1024);assert(wire);size_t length=(size_t)SCREEN_WIDTH*SCREEN_HEIGHT*3;unsigned char *source=malloc(length);assert(source);
    for(int y=0;y<SCREEN_HEIGHT;y++)for(int x=0;x<SCREEN_WIDTH;x++)for(int c=0;c<3;c++)source[((size_t)y*SCREEN_WIDTH+x)*3+c]=(unsigned char)((x/11+y/13)%2?220:30);
    interrupt_once=1;sc_feedback=1;assert(sc_send_desktop(source,length,sc_now_ms()));verify_frame(2560,1440);
    unsigned char ack[12]={0};sc_u16(ack,SC_FRAME_ACK);sc_u16(ack+2,12);sc_u32(ack+4,sc_epoch);sc_u32(ack+8,sc_sequence);
    sc_accept_ack(ack,12,0);assert(sc_frame_input_axis(sc_epoch,sc_sequence,1280,0)==1280&&sc_frame_input_axis(sc_epoch,sc_sequence,720,1)==720);
    unsigned int first_epoch=sc_epoch,first_sequence=sc_sequence;
    wire_length=0;assert(sc_send_desktop(source,length,sc_now_ms()));assert(wire_length==0);
    sc_tier=1080;COMPRESSION_QUALITY=85;sc_force=1;assert(sc_send_desktop(source,length,sc_now_ms()));verify_frame(1920,1080);
    wire_length=0;sc_tier=720;COMPRESSION_QUALITY=80;sc_force=1;assert(sc_send_desktop(source,length,sc_now_ms()));verify_frame(1280,720);
    assert(sc_frame_input_axis(first_epoch,first_sequence,1280,0)==1280); /* 未展示的新尺寸不能提前改变输入映射。 */
    sc_u32(ack+4,sc_epoch);sc_u32(ack+8,sc_sequence);sc_accept_ack(ack,12,0);assert(sc_frame_input_axis(sc_epoch,sc_sequence,640,0)==1280&&sc_frame_input_axis(sc_epoch,sc_sequence,360,1)==720);
    sc_refresh_frame();sc_accept_ack(ack,12,0);assert(sc_frame_input_axis(first_epoch,first_sequence,1280,0)==1280);
    unsigned int previous=sc_acknowledged;sc_u32(ack+8,sc_sequence+100);sc_accept_ack(ack,12,0);assert(sc_acknowledged==previous);
    wire_length=0;sc_tier=540;COMPRESSION_QUALITY=75;sc_force=1;assert(sc_send_desktop(source,length,sc_now_ms()));verify_frame(960,540);
    sc_u32(ack+4,sc_epoch);sc_u32(ack+8,sc_sequence);sc_accept_ack(ack,12,0);
    assert(sc_frame_input_axis(first_epoch,first_sequence,1280,0)==1280);
    assert(sc_frame_input_axis(sc_epoch,sc_sequence,480,0)==1280);
    unsigned int credit=sc_acknowledged;sc_refresh_frame();assert(sc_acknowledged==credit);
    wire_length=0;assert(!sc_send_desktop(source,length-1,sc_now_ms()));assert(wire_length==0);
    free(source);free(wire);sc_release_desktop();release_JPEG_buffer();fprintf(emit_wire?stderr:stdout,"整帧、四档编码、展示确认坐标与短写恢复通过。\n");return 0;
}
