# Linux X11 已安装客户端的三轮历史面板观测；只显示/隐藏窗口，不选择条目。
# 用法：python3 tests/performance/syncclipboard-memory.py
# 需要既有 XDG 用户服务、xprop/xwininfo 和中文历史面板；不安装额外依赖。
import argparse, ctypes as c, subprocess, re, time, os, json, pathlib
parser=argparse.ArgumentParser(description='只显示/隐藏历史面板，采样内存和 CPU，不选择历史项')
parser.add_argument('--cycles',type=int,default=3)
args=parser.parse_args()
if not 1 <= args.cycles <= 30: parser.error('cycles 必须为 1 到 30')
# 只打开历史面板并发送窗口关闭事件，不选择历史项，不读取或保存内容。
for line in subprocess.check_output(['systemctl','--user','show-environment'],text=True).splitlines():
 key,_,value=line.partition('=')
 if key in ['DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS']:os.environ[key]=value
unit='app-xyz.jericx.desktop.syncclipboard@autostart.service'
pid=int(subprocess.check_output(['systemctl','--user','show',unit,'-p','MainPID','--value']))
exe=str(pathlib.Path(f'/proc/{pid}/exe').resolve())
x=c.CDLL('libX11.so.6');x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p];x.XDefaultRootWindow.restype=c.c_ulong
x.XInternAtom.argtypes=[c.c_void_p,c.c_char_p,c.c_int];x.XInternAtom.restype=c.c_ulong
class Data(c.Union):_fields_=[('l',c.c_long*5)]
class Message(c.Structure):_fields_=[('type',c.c_int),('serial',c.c_ulong),('send_event',c.c_int),('display',c.c_void_p),('window',c.c_ulong),('message_type',c.c_ulong),('format',c.c_int),('data',Data)]
class Event(c.Union):_fields_=[('message',Message),('padding',c.c_long*24)]
x.XSendEvent.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_long,c.POINTER(Event)]
x.XFlush.argtypes=[c.c_void_p];x.XCloseDisplay.argtypes=[c.c_void_p]
display=x.XOpenDisplay(None);assert display
root=x.XDefaultRootWindow(display)
def memory():
 status=pathlib.Path(f'/proc/{pid}/status').read_text()
 result={name:int(re.search(r'^'+name+r':\s+(\d+)',status,re.M)[1]) for name in ['VmRSS','VmSwap']}
 rollup=pathlib.Path(f'/proc/{pid}/smaps_rollup').read_text()
 result['Pss']=int(re.search(r'^Pss:\s+(\d+)',rollup,re.M)[1])
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
 result['cpuSeconds']=(int(stat[11])+int(stat[12]))/os.sysconf('SC_CLK_TCK')
 return result
try:
 for cycle in range(args.cycles):
  subprocess.run([exe,'--command-OpenHistoryPanel'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=True)
  time.sleep(2)
  tree=subprocess.check_output(['xwininfo','-root','-tree'],text=True)
  matches=[int(m,16) for m in re.findall(r'(0x[0-9a-f]+) "历史记录": \("SyncClipboard.Desktop.Default" "SyncClipboard.Desktop.Default"\)',tree)]
  assert len(matches)==1,'未找到唯一历史面板'
  active=memory();event=Event();m=event.message;m.type=33;m.display=display;m.window=matches[0];m.message_type=x.XInternAtom(display,b'_NET_CLOSE_WINDOW',0);m.format=32;m.data.l[1]=2
  x.XSendEvent(display,root,0,(1<<20)|(1<<19),c.byref(event));x.XFlush(display)
  time.sleep(2)
  info=subprocess.check_output(['xwininfo','-id',hex(matches[0])],text=True)
  assert 'Map State: IsUnMapped' in info, '历史面板未隐藏'
  assert int(subprocess.check_output(['systemctl','--user','show',unit,'-p','MainPID','--value']))==pid
  print(json.dumps({'cycle':cycle,'activeKiB':active,'closedKiB':memory()}))
finally:x.XCloseDisplay(display)
