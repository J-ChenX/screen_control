/* Windows 实际适配层、GDI+ JPEG 与完整编码参考的同负载检查。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "microstack/screen_control_protocol.h"
#include "meshcore/meshdefines.h"
typedef enum { ILibTransport_DoneState_ERROR=-4, ILibTransport_DoneState_INCOMPLETE=0, ILibTransport_DoneState_COMPLETE=1 } ILibTransport_DoneState;
typedef ILibTransport_DoneState (*ILibKVM_WriteHandler)(char *, int, void *);
int SCREEN_WIDTH=2560,SCREEN_HEIGHT=1440,TILE_WIDTH=32,PIXEL_SIZE=4;
int SCALED_WIDTH=2560,SCALED_HEIGHT=1440,SCREEN_X=0,SCREEN_Y=0,SCALING_FACTOR=1024;
int g_shutdown=0,g_pause=0;
int kvm_server_inputdata(char *b,int n,ILibKVM_WriteHandler w,void*r){return 0;}
#include "meshcore/KVM/Windows/sc_windows_adaptive_desktop.h"
int test_init(void);
void test_finish(void);
int test_decode(const unsigned char*,size_t,unsigned char**,unsigned*,unsigned*);
int get_desktop_buffer(void **,long long *,long *);
int sc_windows_reset_capture(void);
static unsigned char wire[16*1024*1024];static size_t wire_length;
static ILibTransport_DoneState output(char*p,int n,void*r){assert(n>=0&&wire_length+n<=sizeof(wire));memcpy(wire+wire_length,p,n);wire_length+=n;return ILibTransport_DoneState_COMPLETE;}
static double micros(void){LARGE_INTEGER c,f;QueryPerformanceCounter(&c);QueryPerformanceFrequency(&f);return (double)c.QuadPart*1e6/f.QuadPart;}
static int cmp(const void*a,const void*b){double x=*(double*)a,y=*(double*)b;return (x>y)-(x<y);}
static unsigned char *decode(const unsigned char*p,size_t n,unsigned*w,unsigned*h){unsigned char*out=NULL;assert(test_decode(p,n,&out,w,h));return out;}
static unsigned sampling(const unsigned char*p,size_t n){for(size_t k=2;k+10<n;){if(p[k++]!=255)continue;unsigned t=p[k++];if(t==0xd8||t==0xd9)continue;unsigned z=(p[k]<<8)|p[k+1];if(t==0xc0||t==0xc2)return p[k+9];assert(z>=2);k+=z;}return 0;}
int main(int argc,char**argv){
    assert(test_init());sc_writer=output;
    if(argc>1&&strcmp(argv[1],"capture")==0){
        SCREEN_X=GetSystemMetrics(SM_XVIRTUALSCREEN);SCREEN_Y=GetSystemMetrics(SM_YVIRTUALSCREEN);
        SCREEN_WIDTH=SCALED_WIDTH=GetSystemMetrics(SM_CXVIRTUALSCREEN);SCREEN_HEIGHT=SCALED_HEIGHT=GetSystemMetrics(SM_CYVIRTUALSCREEN);
        assert(sc_windows_reset_capture());DWORD before=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);double begin=micros();
        for(int i=0;i<50;i++){void*p=NULL;long long n=0;long cursor[3]={i%2,0,0};assert(get_desktop_buffer(&p,&n,cursor)==0&&p&&n>0);sc_tier=540;wire_length=0;assert(sc_send_desktop(p,n,sc_now_ms()));free(p);}
        DWORD after=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);assert(after<=before+1);
        printf("{\"captureFrames\":50,\"width\":%d,\"height\":%d,\"pixelBytes\":%d,\"gdiGrowth\":%ld,\"meanCaptureAndEncodeMs\":%.3f}\n",SCREEN_WIDTH,SCREEN_HEIGHT,PIXEL_SIZE,(long)after-(long)before,(micros()-begin)/50000.);
        sc_release_desktop();sc_platform_finish();test_finish();return 0;
    }
    const char*scenario=argc>1?argv[1]:"local";unsigned tier=argc>2?atoi(argv[2]):1440;int delta=argc>3?atoi(argv[3]):1;
    int emit=argc>4&&strcmp(argv[4],"--wire")==0; if(emit)_setmode(_fileno(stdout),0x8000);
    sc_tier=tier;COMPRESSION_QUALITY=tier==1440?90:tier==1080?85:tier==720?80:75;sc_delta=delta;sc_feedback=1;
    size_t length=(size_t)SCREEN_WIDTH*SCREEN_HEIGHT*4;unsigned char*source=malloc(length);assert(source);
    ScDesktopSize size=sc_current_size();size_t channels=(size_t)size.width*size.height*3;unsigned char*composed=calloc(1,channels),*edges=calloc(1,channels/3);assert(composed&&edges);
    unsigned frames=strcmp(scenario,"static")==0?12:30,delivered=0,deltas=0,sample=0;uint64_t bytes=0,different=0,error=0;unsigned maxdiff=0;uint64_t outside=0;double times[128],display[128];
    for(unsigned i=0;i<frames;i++){
        for(unsigned y=0;y<(unsigned)SCREEN_HEIGHT;y++)for(unsigned x=0;x<(unsigned)SCREEN_WIDTH;x++)for(unsigned c=0;c<3;c++){
            unsigned yy=strcmp(scenario,"scroll")==0?(y+i*5)%SCREEN_HEIGHT:y;
            int stroke=yy%24>=7&&yy%24<17&&x%13>=3&&x%13<9;unsigned char value=(unsigned char)(stroke?35+c*12:230+c*8);
            if(strcmp(scenario,"local")==0&&y>=417&&y<481&&x>=641+i%12*8&&x<769+i%12*8)value=(unsigned char)(70+i%3*50+c*15);
            if(strcmp(scenario,"motion")==0)value=(unsigned char)(value+i*17+x/32);
            source[((size_t)(SCREEN_HEIGHT-1-y)*SCREEN_WIDTH+x)*4+2-c]=value;
        }
        wire_length=0;double start=micros();assert(sc_send_desktop(source,length,sc_now_ms()));times[i]=(micros()-start)/1000.;
        if(!wire_length)continue;delivered++;bytes+=wire_length;
        unsigned char*m=wire;while(sc_read_u16(m)!=SC_FRAME_METADATA){unsigned n=sc_read_u16(m+2);assert(n&&m+n<wire+wire_length);m+=n;}
        unsigned version=sc_read_u16(m+4),flags=sc_read_u16(m+6),x=0,y=0,w=size.width,h=size.height;
        if(version==2){x=sc_read_u16(m+40);y=sc_read_u16(m+42);w=sc_read_u16(m+44);h=sc_read_u16(m+46);if(flags&4)deltas++;}
        unsigned char*p=m+sc_read_u16(m+2);size_t header=sc_read_u16(p)==MNG_JUMBO?16:8;size_t n=wire_length-(p+header-wire);
        if(!sample)sample=sampling(p+header,n);
        if(!(flags&4))memset(edges,0,channels/3);
        else for(unsigned yy=0;yy<size.height;yy++)for(unsigned xx=0;xx<size.width;xx++){
            if(((xx+2>=x&&xx<=x+1)||(xx+2>=x+w&&xx<=x+w+1))&&yy+2>=y&&yy<=y+h+1)edges[(size_t)yy*size.width+xx]=1;
            if(((yy+2>=y&&yy<=y+1)||(yy+2>=y+h&&yy<=y+h+1))&&xx+2>=x&&xx<=x+w+1)edges[(size_t)yy*size.width+xx]=1;
        }
        unsigned dw,dh;unsigned char*image=decode(p+header,n,&dw,&dh);assert(dw==w&&dh==h&&x+w<=size.width&&y+h<=size.height);
        for(unsigned row=0;row<h;row++)memcpy(composed+((size_t)(row+y)*size.width+x)*3,image+(size_t)row*w*3,w*3);free(image);display[delivered-1]=(micros()-start)/1000.;
        if(emit){unsigned char count[4];sc_u32(count,(unsigned)wire_length);fwrite(count,1,4,stdout);fwrite(wire,1,wire_length,stdout);}
        unsigned char*full=NULL;size_t fulln=0;assert(sc_windows_encode(sc_scaled,size.width,size.height,COMPRESSION_QUALITY,&full,&fulln));image=decode(full,fulln,&dw,&dh);free(full);
        for(size_t k=0;k<channels;k++){unsigned d=abs((int)composed[k]-(int)image[k]);different+=d!=0;outside+=d!=0&&!edges[k/3];if(d>maxdiff)maxdiff=d;error+=abs((int)composed[k]-(int)sc_scaled[k]);}free(image);
        unsigned char ack[12]={0};sc_u16(ack,SC_FRAME_ACK);sc_u16(ack+2,12);sc_u32(ack+4,sc_epoch);sc_u32(ack+8,sc_sequence);sc_accept_ack(ack,12,0);
    }
    PROCESS_MEMORY_COUNTERS_EX before={0},after={0};before.cb=after.cb=sizeof(before);
    assert(GetProcessMemoryInfo(GetCurrentProcess(),(PROCESS_MEMORY_COUNTERS*)&before,sizeof(before)));
    sc_feedback=sc_delta=0;
    for(unsigned repeat=0;repeat<48;repeat++){sc_force=1;wire_length=0;assert(sc_send_desktop(source,length,sc_now_ms()));}
    assert(GetProcessMemoryInfo(GetCurrentProcess(),(PROCESS_MEMORY_COUNTERS*)&after,sizeof(after)));
    long long growth=(long long)after.PrivateUsage-(long long)before.PrivateUsage;
    assert(growth<16*1024*1024);
    qsort(times,frames,sizeof(double),cmp);qsort(display,delivered,sizeof(double),cmp);
    fprintf(emit?stderr:stdout,"{\"scenario\":\"%s\",\"tier\":%u,\"mode\":%d,\"samples\":%u,\"frames\":%u,\"deltaFrames\":%u,\"bytes\":%llu,\"processingMedianMs\":%.3f,\"processingP95Ms\":%.3f,\"nativeDecodeP95Ms\":%.3f,\"meanChannelError\":%.4f,\"differentReferenceChannels\":%llu,\"maxReferenceDifference\":%u,\"jpegYSampling\":%u,\"outsideJpegEdges\":%llu,\"repeatedFullFramePrivateGrowth\":%lld}\n",scenario,tier,delta,frames,delivered,deltas,bytes,times[frames/2],times[(frames-1)*95/100],display[(delivered-1)*95/100],(double)error/(delivered*channels),different,maxdiff,sample,outside,growth);
    free(source);free(composed);free(edges);sc_release_desktop();sc_platform_finish();test_finish();return outside?2:0;
}
