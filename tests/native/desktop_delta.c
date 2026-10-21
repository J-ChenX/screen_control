/* 同一合成桌面的整帧/矩形增量对照；实际 JPEG 解码重建并与完整编码逐通道核对。 */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <jpeglib.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
int SCREEN_WIDTH=2560,SCREEN_HEIGHT=1440,TILE_WIDTH=32,slave2master[2]={0,1},COMPRESSION_QUALITY=90;
static unsigned char wire[16*1024*1024];static size_t wire_length;
int ILibMemory_Copy_s(void*d,size_t cap,void*s,size_t n){assert(n<=cap);memcpy(d,s,n);return 0;}
void ILib_POSIX_CrashHandler(int code){exit(code);}
void kvm_send_resolution(void){}
static ssize_t test_write(int fd,const void*data,size_t n){(void)fd;assert(wire_length+n<=sizeof(wire));memcpy(wire+wire_length,data,n);wire_length+=n;return (ssize_t)n;}
#define write test_write
#include "meshcore/KVM/Linux/sc_adaptive_desktop.h"
#undef write
static unsigned read16(const unsigned char*p){return p[0]*256u+p[1];}
static unsigned read32(const unsigned char*p){return read16(p)*65536u+read16(p+2);}
static unsigned char*decode(const unsigned char*data,size_t n,unsigned*w,unsigned*h){
    struct jpeg_decompress_struct d={0};struct jpeg_error_mgr e;d.err=jpeg_std_error(&e);jpeg_create_decompress(&d);jpeg_mem_src(&d,data,n);assert(jpeg_read_header(&d,1)==JPEG_HEADER_OK);jpeg_start_decompress(&d);
    *w=d.output_width;*h=d.output_height;assert(d.output_components==3);unsigned char*out=malloc((size_t)*w**h*3);assert(out);
    while(d.output_scanline<d.output_height){JSAMPROW row=out+(size_t)d.output_scanline**w*3;assert(jpeg_read_scanlines(&d,&row,1)==1);}jpeg_finish_decompress(&d);jpeg_destroy_decompress(&d);return out;
}
static int compare_double(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
static double micros(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (double)t.tv_sec*1e6+t.tv_nsec/1000.;}
int main(int argc,char**argv){
    const char*scenario=argc>1?argv[1]:"local";int emit=argc>2&&strcmp(argv[2],"--wire")==0;
    const unsigned width=SCREEN_WIDTH,height=SCREEN_HEIGHT;size_t length=(size_t)width*height*3;
    unsigned char*source=malloc(length),*base=malloc(length),*composed=calloc(1,length);assert(source&&base&&composed);
    for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++){
        unsigned stroke=y%24>=7&&y%24<17&&x%13>=3&&x%13<9;
        for(unsigned c=0;c<3;c++)base[((size_t)y*width+x)*3+c]=(unsigned char)(stroke?35+c*12:230+c*8);
    }
    unsigned frames=strcmp(scenario,"static")==0?30:90,deltas=0,delivered=0;uint64_t bytes=0,error=0,different=0;double samples[128];unsigned last_epoch=0,last_sequence=0;
#ifdef SC_ADAPTIVE_DELTA
    sc_delta=1;
#endif
    sc_feedback=1;
    for(unsigned i=0;i<frames;i++){
        memcpy(source,base,length);
        if(strcmp(scenario,"local")==0){unsigned left=640+(i%12)*8;for(unsigned y=416;y<480;y++)for(unsigned x=left;x<left+128;x++)for(unsigned c=0;c<3;c++)source[((size_t)y*width+x)*3+c]=(unsigned char)(70+(i%3)*50+c*15);}
        else if(strcmp(scenario,"scroll")==0){for(unsigned y=0;y<height;y++)memcpy(source+(size_t)y*width*3,base+(size_t)((y+i*5)%height)*width*3,(size_t)width*3);}
        else if(strcmp(scenario,"motion")==0){for(size_t p=0;p<length;p++)source[p]=(unsigned char)(base[p]+i*17+(p/3%width)/32);}
        wire_length=0;double start=micros();assert(sc_send_desktop(source,length,sc_now_ms()));samples[i]=micros()-start;
        if(!wire_length)continue;
        delivered++;bytes+=wire_length;
        const unsigned char*m=wire;if(read16(m)==0x7f04){assert(read16(m+2)==8);m+=8;}
        assert(read16(m)==SC_FRAME_METADATA);unsigned version=read16(m+4),flags=read16(m+6),epoch=read32(m+8),sequence=read32(m+12),x=0,y=0,w=width,h=height;
        if(version==2){assert(read16(m+2)==56);x=read16(m+40);y=read16(m+42);w=read16(m+44);h=read16(m+46);
            if(flags&4){assert(read32(m+36)==last_sequence&&read32(m+48)==last_epoch&&!(flags&1));deltas++;}else assert(read32(m+36)==0&&read32(m+48)==0&&x==0&&y==0&&w==width&&h==height);
        }
        const unsigned char*packet=m+read16(m+2);size_t header=read16(packet)==MNG_JUMBO?16:8;assert(read16(packet+(header==16?12:4))==x&&read16(packet+(header==16?14:6))==y);
        size_t count=wire_length-(size_t)(packet+header-wire);unsigned dw,dh;unsigned char*image=decode(packet+header,count,&dw,&dh);assert(dw==w&&dh==h&&x+w<=width&&y+h<=height);
        for(unsigned row=0;row<h;row++)memcpy(composed+((size_t)(row+y)*width+x)*3,image+(size_t)row*w*3,(size_t)w*3);free(image);
        if(emit){unsigned char size[4];sc_u32(size,wire_length);assert(fwrite(size,1,4,stdout)==4);assert(fwrite(wire,1,wire_length,stdout)==wire_length);}
        /* 独立完整编码是画面正确性参考，不计入发送耗时。 */
        assert(write_JPEG_buffer(source,width,height,COMPRESSION_QUALITY)==0);image=decode(jpeg_buffer,jpeg_buffer_length,&dw,&dh);
        for(size_t p=0;p<length;p++){different+=composed[p]!=image[p];error+=(uint64_t)abs((int)source[p]-composed[p]);}free(image);finish_JPEG_tile();
        assert(different==0);last_epoch=epoch;last_sequence=sequence;
        unsigned char ack[12]={0};sc_u16(ack,SC_FRAME_ACK);sc_u16(ack+2,12);sc_u32(ack+4,epoch);sc_u32(ack+8,sequence);sc_accept_ack(ack,12,0);
    }
    qsort(samples,frames,sizeof(double),compare_double);
    fprintf(emit?stderr:stdout,"{\"scenario\":\"%s\",\"samples\":%u,\"frames\":%u,\"deltaFrames\":%u,\"bytes\":%llu,\"processingMedianMs\":%.3f,\"processingP95Ms\":%.3f,\"meanChannelError\":%.4f,\"differentReferenceChannels\":%llu}\n",scenario,frames,delivered,deltas,(unsigned long long)bytes,samples[frames/2]/1000,samples[(frames-1)*95/100]/1000,(double)error/((double)delivered*length),(unsigned long long)different);
    free(source);free(base);free(composed);sc_release_desktop();release_JPEG_buffer();return 0;
}
