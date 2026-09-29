#!/usr/bin/env python3
"""验证事件转发在源对象关闭后解除代理且不删除用户监听器。"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from event_emitter_forward_lifetime import build_direct_probe


SCRIPT = r"""
var events=require('events'), index=0;
var result={existingStale:0,lateSyncStale:0,lateStale:0,ownFailures:0,hookFailures:0};
function next(){
 if(index===__COUNT__*2){console.log('result='+JSON.stringify(result));process.exit(0);}
 var late=index>=__COUNT__, source={},target={},ownCalls=0,targetCalls=0;
 var emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(target,true).createEvent('ping');
 source.on('ping',function(){ownCalls++;});
 var baselineNew=target.listenerCount('newListener');
 var baselineRemove=target.listenerCount('removeListener');
 if(!__scForward(source,target)){console.log('forward-failed');process.exit(2);}
 if(!late)target.on('ping',function(){targetCalls++;});
 source.emit('close');
 if(late){
  target.on('ping',function(){targetCalls++;});
  if(source.listenerCount('ping')!==1)result.lateSyncStale++;
 }
 setTimeout(function(){
  if(source.listenerCount('ping')!==1){
   if(late)result.lateStale++;else result.existingStale++;
  }
  source.emit('ping');
  if(ownCalls!==1||target.listenerCount('ping')!==1)result.ownFailures++;
  if(targetCalls!==0||target.listenerCount('newListener')!==baselineNew||
     target.listenerCount('removeListener')!==baselineRemove||
     source.listenerCount('close')!==0)result.hookFailures++;
  index++;setTimeout(next,0);
 },10);
}
next();
"""

MULTI_SCRIPT = r"""
var events=require('events'),a={},b={},target={},calls=0;
function init(source){
 var emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
}
init(a);init(b);events.EventEmitter.call(target,true).createEvent('ping');
if(!__scForward(a,target)||!__scForward(b,target))process.exit(2);
target.on('ping',function(){calls++;});
a.emit('close');
setTimeout(function(){
 a.emit('ping');b.emit('ping');
 console.log('multi='+JSON.stringify({a:a.listenerCount('ping'),b:b.listenerCount('ping'),
                                    calls:calls,close:a.listenerCount('close')}));
 var source={},sink={},emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(sink,true).createEvent('ping');
 if(!__scForward(source,sink))process.exit(2);
 function listener(){}
 sink.on('ping',listener);sink.on('ping',listener);
 sink.removeListener('ping',listener);
 var afterRemove=source.listenerCount('ping');
 source.emit('close');
 setTimeout(function(){
  console.log('duplicate='+JSON.stringify({afterRemove:afterRemove,
   afterClose:source.listenerCount('ping'),target:sink.listenerCount('ping'),
   close:source.listenerCount('close')}));
  var churnSource={},churnTarget={},churnEmitter=events.EventEmitter.call(churnSource,true);
  churnEmitter.createEvent('ping');churnEmitter.createEvent('close');
  events.EventEmitter.call(churnTarget,true).createEvent('ping');
  if(!__scForward(churnSource,churnTarget))process.exit(2);
  for(var n=0;n<1000;n++){
   var active=function(){};
   churnTarget.on('ping',active);churnTarget.removeListener('ping',active);
  }
  console.log('churn='+JSON.stringify({source:churnSource.listenerCount('ping'),
                                     target:churnTarget.listenerCount('ping')}));
  process.exit(0);
 },20);
},20);
"""

SCHEDULE_SCRIPT = r"""
var events=require('events'), index=0, result={stale:0,overrideCalls:0,ownFailures:0};
function next(){
 if(index===__COUNT__*2){console.log('schedule='+JSON.stringify(result));process.exit(0);}
 var source={},target={},emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(target,true).createEvent('ping');
 var baselineNew=target.listenerCount('newListener');
 var baselineRemove=target.listenerCount('removeListener');
 var old=setImmediate;
 var replacement=function(){result.overrideCalls++;throw new Error('调度函数被覆盖');};
 if(index>=__COUNT__)setImmediate=replacement;
 if(!__scForward(source,target)){console.log('forward-failed');process.exit(2);}
 target.on('ping',function(){});
 setImmediate=replacement;
 source.emit('close');
 setImmediate=old;
 setTimeout(function(){
  _debugGC();
  if(source.listenerCount('ping')!==0||source.listenerCount('close')!==0||
     target.listenerCount('newListener')!==baselineNew||
     target.listenerCount('removeListener')!==baselineRemove)result.stale++;
  if(target.listenerCount('ping')!==1)result.ownFailures++;
  index++;setTimeout(next,0);
 },10);
}
next();
"""

REENTRANT_CLOSE_SCRIPT = r"""
var events=require('events'), index=0;
var result={returnSuccess:0,forwarded:0,sourceHooks:0,targetHooks:0,missingClose:0};
function next(){
 if(index===__COUNT__){console.log('reentrant='+JSON.stringify(result));process.exit(0);}
 var source={},target={},calls=0,closedDuringSetup=0;
 var emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(target,true).createEvent('ping');
 source.on('newListener',function(name){if(name==='close'){closedDuringSetup++;source.emit('close');}});
 target.on('ping',function(){calls++;});
 var baselineNew=target.listenerCount('newListener');
 var baselineRemove=target.listenerCount('removeListener');
 if(__scForward(source,target))result.returnSuccess++;
 source.emit('ping');
 setTimeout(function(){
  if(closedDuringSetup!==1)result.missingClose++;
  if(calls!==0)result.forwarded++;
  if(source.listenerCount('ping')!==0||source.listenerCount('close')!==0)result.sourceHooks++;
  if(target.listenerCount('newListener')!==baselineNew||
     target.listenerCount('removeListener')!==baselineRemove)result.targetHooks++;
  index++;setTimeout(next,0);
 },10);
}
next();
"""

REENTRANT_STAGES_SCRIPT = r"""
var events=require('events'),index=0;
var names=['sourcePing','targetListeners','targetNewHook','targetRemoveHook'];
var result={returnSuccess:0,immediateForward:0,staleHooks:0,missingClose:0};
function next(){
 if(index===__COUNT__*names.length){
  console.log('stages='+JSON.stringify(result));process.exit(0);
 }
 var stage=names[index%names.length],source={},target={},calls=0,closed=0;
 var emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(target,true).createEvent('ping');
 target.on('ping',function(){calls++;});
 var baselineNew=target.listenerCount('newListener');
 var baselineRemove=target.listenerCount('removeListener');
 if(stage==='sourcePing'){
  source.on('newListener',function(name){if(name==='ping'){closed++;source.emit('close');}});
 }else if(stage==='targetListeners'){
  var originalListeners=target.listeners;
  target.listeners=function(name){closed++;source.emit('close');return originalListeners.call(this,name);};
 }else{
  var originalOn=target.on;
  target.on=function(name,listener){
   var value=originalOn.call(this,name,listener);
   if((stage==='targetNewHook'&&name==='newListener')||
      (stage==='targetRemoveHook'&&name==='removeListener')){
    closed++;source.emit('close');
   }
   return value;
  };
 }
 if(__scForward(source,target))result.returnSuccess++;
 source.emit('ping');
 if(calls!==0)result.immediateForward++;
 setTimeout(function(){
  if(closed!==1)result.missingClose++;
  if(source.listenerCount('ping')!==0||source.listenerCount('close')!==0||
     target.listenerCount('newListener')!==baselineNew||
     target.listenerCount('removeListener')!==baselineRemove)result.staleHooks++;
  index++;next();
 },10);
}
next();
"""

IMMEDIATE_AFTER_CLOSE_SCRIPT = r"""
var events=require('events'),source={},target={},calls=0;
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
target.on('ping',function(){calls++;});
if(!__scForward(source,target))process.exit(2);
source.emit('close');source.emit('ping');
var immediate=calls;
setTimeout(function(){
 console.log('immediate='+JSON.stringify({immediate:immediate,after:calls,
   ping:source.listenerCount('ping'),close:source.listenerCount('close')}));
 process.exit(0);
},10);
"""

NO_CLOSE_SCRIPT = r"""
var events=require('events'),source={},target={},calls=0,finalized=0;
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');
events.EventEmitter.call(target,true).createEvent('ping');
source.on('~',function(){finalized++;});
target.on('ping',function(){calls++;});
var baselineNew=target.listenerCount('newListener');
var baselineRemove=target.listenerCount('removeListener');
var success=__scForward(source,target);
source.emit('ping');source=null;
var remaining=100;
function collect(){
 _debugGC();
 if(--remaining===0){
  console.log('noClose='+JSON.stringify({success:success,calls:calls,
   finalized:finalized,newHooks:target.listenerCount('newListener')-baselineNew,
   removeHooks:target.listenerCount('removeListener')-baselineRemove}));
  process.exit(0);
 }
 setTimeout(collect,0);
}
collect();
"""

THROWING_REMOVE_EVENT_SCRIPT = r"""
var events=require('events'),source={},target={},calls=0;
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
target.on('ping',function(){calls++;});
source.on('removeListener',function(){throw new Error('源元事件抛错');});
target.on('removeListener',function(){throw new Error('目标元事件抛错');});
var baselineNew=target.listenerCount('newListener');
var baselineRemove=target.listenerCount('removeListener');
if(!__scForward(source,target))process.exit(2);
source.emit('close');source.emit('ping');
setTimeout(function(){
 console.log('removeEvent='+JSON.stringify({calls:calls,
  ping:source.listenerCount('ping'),close:source.listenerCount('close'),
  newHooks:target.listenerCount('newListener')-baselineNew,
  removeHooks:target.listenerCount('removeListener')-baselineRemove}));
 process.exit(0);
},10);
"""

FORWARD_ARGUMENT_SCRIPT = r"""
var events=require('events'),source={},target={},payload={value:42};
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
var result={calls:0,thisOk:false,payloadOk:false,textOk:false};
target.on('ping',function(first,second){
 result.calls++;
 result.thisOk=this===target;
 result.payloadOk=first===payload;
 result.textOk=second==='two';
});
if(!__scForward(source,target))process.exit(2);
source.emit('ping',payload,'two');
source.emit('close');
console.log('arguments='+JSON.stringify(result));
process.exit(0);
"""

NATIVE_COUNT_SCRIPT = r"""
var events=require('events'),source={},target={};
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
target.on('ping',function(){});
var initial=__scHasListeners(source,'ping');
var success=__scForward(source,target);
var active=__scHasListeners(source,'ping');
source.emit('close');
setTimeout(function(){
 console.log('nativeCount='+JSON.stringify({initial:initial,success:success,active:active,
  sourcePing:source.listenerCount('ping'),nativePing:__scHasListeners(source,'ping'),
  sourceClose:source.listenerCount('close'),nativeClose:__scHasListeners(source,'close'),
  targetRemove:target.listenerCount('removeListener'),
  nativeTargetRemove:__scHasListeners(target,'removeListener')}));
 process.exit(0);
},20);
"""

LATE_HOOK_SCRIPT = r"""
var events=require('events'),source={},target={},closed=0;
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
target.on('ping',function(){});
target.on('newListener',function(name){
 if(name==='removeListener'){closed++;source.emit('close');}
});
var before=target.listenerCount('removeListener');
var success=__scForward(source,target);
setTimeout(function(){
 console.log('lateHook='+JSON.stringify({success:success,closed:closed,
  sourcePing:source.listenerCount('ping'),sourceClose:source.listenerCount('close'),
  targetRemove:target.listenerCount('removeListener')-before}));
 process.exit(0);
},20);
"""

CLOSE_ORDER_SCRIPT = r"""
var events=require('events'),source={},target={},order=[];
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(target,true).createEvent('ping');
source.on('close',function(){order.push('before');});
target.on('ping',function(){});
if(!__scForward(source,target))process.exit(2);
source.on('close',function(){order.push('after');});
source.emit('close');
setTimeout(function(){
 console.log('closeOrder='+JSON.stringify({order:order,ping:source.listenerCount('ping'),
  close:source.listenerCount('close')}));
 process.exit(0);
},20);
"""

GETTER_STAGES_SCRIPT = r"""
var events=require('events');
var names=['listeners','bind','sourceOn','targetOn','length','pop'],result={};
for(var i=0;i<names.length;i++){
 var stage=names[i],source={},target={},closed=0,threw=false,success;
 var emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 events.EventEmitter.call(target,true).createEvent('ping');
 var listener=function(){};
 if(stage==='bind')Object.defineProperty(listener,'bind',{get:function(){
  closed++;source.emit('close');throw new Error('bind getter fault');
 }});
 if(stage!=='targetOn')target.on('ping',listener);
 if(stage==='listeners')Object.defineProperty(target,'listeners',{get:function(){
  closed++;source.emit('close');throw new Error('listeners getter fault');
 }});
 if(stage==='sourceOn')Object.defineProperty(source,'on',{get:function(){
  closed++;source.emit('close');throw new Error('source on getter fault');
 }});
 if(stage==='targetOn')Object.defineProperty(target,'on',{get:function(){
  closed++;source.emit('close');throw new Error('target on getter fault');
 }});
 if(stage==='length')target.listeners=function(){
  var items={};Object.defineProperty(items,'length',{get:function(){
   closed++;source.emit('close');throw new Error('length getter fault');
  }});return items;
 };
 if(stage==='pop')target.listeners=function(){
  var items=[];items.length=1;Object.defineProperty(items,'0',{get:function(){
   closed++;source.emit('close');throw new Error('pop getter fault');
  }});return items;
 };
 try{success=__scForward(source,target);}catch(error){threw=true;}
 result[stage]={closed:closed,threw:threw,success:success===true,
  ping:source.listenerCount('ping'),close:source.listenerCount('close'),
  finalizer:__scFinalizerDepth(source),nativePing:__scHasListeners(source,'ping'),
  nativeClose:__scHasListeners(source,'close')};
}
console.log('getterStages='+JSON.stringify(result));
process.exit(0);
"""

FINALIZER_CHAIN_SCRIPT = r"""
var events=require('events'),source={},a={},b={},round=0,finalized=0;
var result={activeDepth:0,closedDepth:0,finalized:0,sourceHooks:0,
            frozenDepth:0,frozenHooks:0,frozenFinalized:0};
var emitter=events.EventEmitter.call(source,true);
emitter.createEvent('ping');emitter.createEvent('close');
events.EventEmitter.call(a,true).createEvent('ping');
events.EventEmitter.call(b,true).createEvent('ping');
source.on('~',function(){finalized++;});
if(typeof __scFinalizerDepth!=='function'){
 console.log('missing-finalizer-depth-hook');process.exit(2);
}
function next(){
 if(round===__COUNT__){
  result.sourceHooks=source.listenerCount('ping')+source.listenerCount('close');
  source=null;
  var remaining=100;
  function collect(){
   _debugGC();
   if(--remaining===0){
    result.finalized=finalized;
    checkFrozen();return;
   }
   setTimeout(collect,0);
  }
  collect();return;
 }
 if(!__scForward(source,a)||!__scForward(source,b)){
  console.log('forward-failed='+round);process.exit(2);
 }
 if(__scFinalizerDepth(source)!==2)result.activeDepth++;
 source.emit('close');
 setTimeout(function(){
  if(__scFinalizerDepth(source)!==0)result.closedDepth++;
  round++;next();
 },0);
}
next();
function checkFrozen(){
 var frozen={},sink={},frozenFinalized=0;
 var frozenEmitter=events.EventEmitter.call(frozen,true);
 frozenEmitter.createEvent('ping');frozenEmitter.createEvent('close');
 events.EventEmitter.call(sink,true).createEvent('ping');
 frozen.on('~',function(){frozenFinalized++;});
 if(!__scForward(frozen,sink)){console.log('frozen-forward-failed');process.exit(2);}
 Object.freeze(frozen);
 frozen.emit('close');
 setTimeout(function(){
  result.frozenDepth=__scFinalizerDepth(frozen);
  result.frozenHooks=frozen.listenerCount('ping')+frozen.listenerCount('close');
  frozen=null;
  var remaining=100;
  function collect(){
   _debugGC();
   if(--remaining===0){
    result.frozenFinalized=frozenFinalized;
    console.log('finalizer='+JSON.stringify(result));process.exit(0);
   }
   setTimeout(collect,0);
  }
  collect();
 },0);
}
"""


def run_finalizer_chain(binary: Path, count: int) -> None:
    with tempfile.TemporaryDirectory(prefix="screen-control-finalizer-chain-") as temporary:
        script = Path(temporary) / "finalizer-chain.js"
        script.write_text(FINALIZER_CHAIN_SCRIPT.replace("__COUNT__", str(count)))
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                 env=environment, capture_output=True, text=True,
                                 timeout=max(30, count // 2))
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr or \
                "UNCAUGHT EXCEPTION" in process.stdout or \
                "UNCAUGHT EXCEPTION" in process.stderr:
            raise RuntimeError(f"终结器链测试失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
        lines = [line for line in process.stdout.splitlines() if line.startswith("finalizer=")]
        if len(lines) != 1:
            raise RuntimeError(f"缺少终结器链结果：{process.stdout[-700:]}")
        result = json.loads(lines[0].split("=", 1)[1])
        expected = {"activeDepth": 0, "closedDepth": 0, "finalized": 1,
                    "sourceHooks": 0, "frozenDepth": 1, "frozenHooks": 0,
                    "frozenFinalized": 1}
        if result != expected:
            raise RuntimeError(f"终结器包装或原有终结回调异常：{result}，预期 {expected}")
        print(f"同一源双转发并关闭 {count} 次：{result}；无 ASan/UBSan 报告")


def run_boundary(binary: Path, label: str, body: str, expected: dict) -> None:
    with tempfile.TemporaryDirectory(prefix="screen-control-forward-boundary-") as temporary:
        script = Path(temporary) / "boundary.js"
        script.write_text(body)
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1",
                           UBSAN_OPTIONS="halt_on_error=1")
        process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                 env=environment, capture_output=True, text=True, timeout=20)
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr or \
                "UNCAUGHT EXCEPTION" in process.stdout or \
                "UNCAUGHT EXCEPTION" in process.stderr:
            raise RuntimeError(f"{label} 边界测试失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
        lines = [line for line in process.stdout.splitlines()
                 if line.startswith(label + "=")]
        if len(lines) != 1:
            raise RuntimeError(f"缺少 {label} 结果：{process.stdout[-700:]}")
        actual = json.loads(lines[0].split("=", 1)[1])
        if actual != expected:
            raise RuntimeError(f"{label} 结果异常：{actual}，预期 {expected}")
        print(f"{label}：{actual}；无 ASan/UBSan 报告")


def run(binary: Path, count: int, expect_stale: bool,
        expect_schedule_stale: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="screen-control-forward-close-run-") as temporary:
        script = Path(temporary) / "forward-close.js"
        script.write_text(SCRIPT.replace("__COUNT__", str(count)))
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        try:
            process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                     env=environment, capture_output=True, text=True,
                                     timeout=max(20, count * 0.5 + 10))
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"关闭清理测试超时：stdout={(error.stdout or b'')[-700:]!r}，"
                               f"stderr={(error.stderr or b'')[-1200:]!r}") from error
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr:
            raise RuntimeError(f"关闭清理测试失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
        lines = [line for line in process.stdout.splitlines() if line.startswith("result=")]
        if len(lines) != 1:
            raise RuntimeError(f"缺少关闭清理结果：{process.stdout[-700:]}")
        result = json.loads(lines[0].split("=", 1)[1])
        if expect_stale:
            expected = {"existingStale": count, "lateSyncStale": count,
                        "lateStale": count, "ownFailures": 0, "hookFailures": count * 2}
        else:
            expected = {"existingStale": 0, "lateSyncStale": 0,
                        "lateStale": 0, "ownFailures": 0, "hookFailures": 0}
        if result != expected:
            raise RuntimeError(f"关闭清理计数异常：{result}，预期 {expected}")
        script.write_text(MULTI_SCRIPT)
        process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                 env=environment, capture_output=True, text=True, timeout=20)
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr:
            raise RuntimeError(f"多源及重复监听器测试失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
        lines = process.stdout.splitlines()
        if len(lines) != 3 or not lines[0].startswith("multi=") or \
                not lines[1].startswith("duplicate=") or not lines[2].startswith("churn="):
            raise RuntimeError(f"多源及重复监听器计数缺失：{process.stdout[-700:]}")
        multi = json.loads(lines[0].split("=", 1)[1])
        duplicate = json.loads(lines[1].split("=", 1)[1])
        churn = json.loads(lines[2].split("=", 1)[1])
        if expect_stale:
            expected_multi = {"a": 1, "b": 1, "calls": 2, "close": 1}
            expected_duplicate = {"afterRemove": 1, "afterClose": 1,
                                  "target": 1, "close": 1}
        else:
            expected_multi = {"a": 0, "b": 1, "calls": 1, "close": 0}
            expected_duplicate = {"afterRemove": 1, "afterClose": 0,
                                  "target": 1, "close": 0}
        if multi != expected_multi or duplicate != expected_duplicate:
            raise RuntimeError(f"多源或重复监听器清理异常：{multi}、{duplicate}；"
                               f"预期 {expected_multi}、{expected_duplicate}")
        if churn != {"source": 0, "target": 0}:
            raise RuntimeError(f"反复注册移除后仍有代理：{churn}")
        script.write_text(SCHEDULE_SCRIPT.replace("__COUNT__", str(count)))
        process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                 env=environment, capture_output=True, text=True,
                                 timeout=max(20, count * 0.5 + 10))
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr:
            raise RuntimeError(f"调度函数覆盖测试失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
        lines = [line for line in process.stdout.splitlines() if line.startswith("schedule=")]
        if len(lines) != 1:
            raise RuntimeError(f"缺少调度函数覆盖结果：{process.stdout[-700:]}")
        schedule = json.loads(lines[0].split("=", 1)[1])
        schedule_stale = expect_schedule_stale or expect_stale
        expected_schedule = {"stale": count * 2 if schedule_stale else 0,
                             "overrideCalls": count * 2 if schedule_stale else 0,
                             "ownFailures": 0}
        if schedule != expected_schedule:
            raise RuntimeError(f"调度函数覆盖结果异常：{schedule}，预期 {expected_schedule}")
        if not expect_stale:
            script.write_text(REENTRANT_CLOSE_SCRIPT.replace("__COUNT__", str(count)))
            process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                     env=environment, capture_output=True, text=True,
                                     timeout=max(20, count * 0.5 + 10))
            if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                    "runtime error:" in process.stderr:
                raise RuntimeError(f"注册期间同步关闭测试失败：exit={process.returncode}，"
                                   f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
            lines = [line for line in process.stdout.splitlines() if line.startswith("reentrant=")]
            if len(lines) != 1:
                raise RuntimeError(f"缺少注册期间同步关闭结果：{process.stdout[-700:]}")
            reentrant = json.loads(lines[0].split("=", 1)[1])
            expected_reentrant = {"returnSuccess": 0, "forwarded": 0, "sourceHooks": 0,
                                  "targetHooks": 0, "missingClose": 0}
            if reentrant != expected_reentrant:
                raise RuntimeError(f"注册期间同步关闭后仍保留代理：{reentrant}")
            script.write_text(REENTRANT_STAGES_SCRIPT.replace("__COUNT__", str(count)))
            process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                     env=environment, capture_output=True, text=True,
                                     timeout=max(30, count))
            if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                    "runtime error:" in process.stderr:
                raise RuntimeError(f"各注册阶段同步关闭测试失败：exit={process.returncode}，"
                                   f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
            lines = [line for line in process.stdout.splitlines() if line.startswith("stages=")]
            if len(lines) != 1:
                raise RuntimeError(f"缺少注册阶段结果：{process.stdout[-700:]}")
            stages = json.loads(lines[0].split("=", 1)[1])
            if stages != {"returnSuccess": 0, "immediateForward": 0,
                          "staleHooks": 0, "missingClose": 0}:
                raise RuntimeError(f"注册阶段关闭后仍可转发或保留钩子：{stages}")
            script.write_text(IMMEDIATE_AFTER_CLOSE_SCRIPT)
            process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                     env=environment, capture_output=True, text=True,
                                     timeout=20)
            if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                    "runtime error:" in process.stderr:
                raise RuntimeError(f"关闭后同步事件测试失败：exit={process.returncode}，"
                                   f"stdout={process.stdout[-700:]}，stderr={process.stderr[-1200:]}")
            lines = [line for line in process.stdout.splitlines() if line.startswith("immediate=")]
            if len(lines) != 1:
                raise RuntimeError(f"缺少关闭后同步事件结果：{process.stdout[-700:]}")
            immediate = json.loads(lines[0].split("=", 1)[1])
            if immediate != {"immediate": 0, "after": 0, "ping": 0, "close": 0}:
                raise RuntimeError(f"关闭后同步事件仍转发或保留代理：{immediate}")
            for label, body, expected in (
                ("noClose", NO_CLOSE_SCRIPT,
                 {"success": True, "calls": 1, "finalized": 1,
                  "newHooks": 0, "removeHooks": 0}),
                ("removeEvent", THROWING_REMOVE_EVENT_SCRIPT,
                 {"calls": 0, "ping": 0, "close": 0,
                  "newHooks": 0, "removeHooks": 0}),
                ("arguments", FORWARD_ARGUMENT_SCRIPT,
                 {"calls": 1, "thisOk": True, "payloadOk": True,
                  "textOk": True}),
            ):
                script.write_text(body)
                process = subprocess.run([str(binary), str(script)], cwd=temporary,
                                         env=environment, capture_output=True, text=True,
                                         timeout=20)
                if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                        "runtime error:" in process.stderr or \
                        (label != "removeEvent" and
                         ("UNCAUGHT EXCEPTION" in process.stdout or
                          "UNCAUGHT EXCEPTION" in process.stderr)):
                    raise RuntimeError(f"{label} 测试失败：exit={process.returncode}，"
                                       f"stdout={process.stdout[-700:]}，"
                                       f"stderr={process.stderr[-1200:]}")
                if label == "removeEvent":
                    errors = [line for line in (process.stdout + process.stderr).splitlines()
                              if "UNCAUGHT EXCEPTION" in line]
                    if not errors or not all("源元事件抛错" in line or
                                             "目标元事件抛错" in line for line in errors):
                        raise RuntimeError(f"移除元事件异常与预期不符：{errors}")
                lines = [line for line in process.stdout.splitlines()
                         if line.startswith(label + "=")]
                if len(lines) != 1:
                    raise RuntimeError(f"缺少 {label} 结果：{process.stdout[-700:]}")
                actual = json.loads(lines[0].split("=", 1)[1])
                if actual != expected:
                    raise RuntimeError(f"{label} 清理结果异常：{actual}，预期 {expected}")
        print(f"关闭前和关闭后新增监听器各 {count} 次：{result}；"
              f"多源 {multi}、重复监听器 {duplicate}、反复注册 {churn}、"
              f"调度函数覆盖 {schedule}；注册期间同步关闭 "
              f"{reentrant if not expect_stale else '跳过旧候选'}；"
              f"注册阶段 {stages if not expect_stale else '跳过旧候选'}；"
              f"关闭后同步事件 {immediate if not expect_stale else '跳过旧候选'}；"
              "无 ASan/UBSan 报告")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--candidate", type=Path)
    source.add_argument("--binary", type=Path)
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--expect-stale", action="store_true")
    parser.add_argument("--expect-schedule-stale", action="store_true")
    parser.add_argument("--check-finalizer-chain", action="store_true",
                        help="要求二进制提供隔离测试钩子 __scFinalizerDepth")
    parser.add_argument("--check-native-count", action="store_true",
                        help="要求二进制提供隔离测试钩子 __scHasListeners")
    parser.add_argument("--check-late-hook", action="store_true",
                        help="检查原生调度失败时目标元事件注册中同步关闭的清理")
    parser.add_argument("--check-install-throw", action="store_true",
                        help="要求隔离二进制提供原生计数与终结器深度钩子")
    args = parser.parse_args()
    if not 1 <= args.count <= 1000:
        parser.error("--count 必须介于 1 和 1000 之间")
    if args.binary is not None:
        binary = args.binary.resolve(strict=True)
        run(binary, args.count, args.expect_stale, args.expect_schedule_stale)
        if args.check_finalizer_chain:
            run_finalizer_chain(binary, args.count)
        if args.check_native_count:
            run_boundary(binary, "nativeCount", NATIVE_COUNT_SCRIPT,
                         {"initial": -1, "success": True, "active": 1,
                          "sourcePing": 0, "nativePing": 0, "sourceClose": 0,
                          "nativeClose": 0, "targetRemove": 1,
                          "nativeTargetRemove": 1})
        if args.check_late_hook:
            run_boundary(binary, "lateHook", LATE_HOOK_SCRIPT,
                         {"success": False, "closed": 1, "sourcePing": 0,
                          "sourceClose": 0, "targetRemove": 0})
        if args.check_install_throw:
            run_boundary(binary, "getterStages", GETTER_STAGES_SCRIPT,
                         {name: {"closed": 1, "threw": False, "success": False,
                                 "ping": 0, "close": 0, "finalizer": 0,
                                 "nativePing": -1, "nativeClose": 0}
                          for name in ("listeners", "bind", "sourceOn", "targetOn",
                                       "length", "pop")})
        run_boundary(binary, "closeOrder", CLOSE_ORDER_SCRIPT,
                     {"order": ["before", "after"], "ping": 0, "close": 2})
    else:
        with tempfile.TemporaryDirectory(prefix="screen-control-forward-close-build-") as temporary:
            binary = build_direct_probe(args.candidate.resolve(strict=True),
                                        Path(temporary) / "source")
            run(binary, args.count, args.expect_stale, args.expect_schedule_stale)
            if args.check_finalizer_chain:
                run_finalizer_chain(binary, args.count)
            if args.check_native_count or args.check_late_hook or args.check_install_throw:
                parser.error("原生计数、调度故障和安装异常钩子仅在隔离二进制中提供")
            run_boundary(binary, "closeOrder", CLOSE_ORDER_SCRIPT,
                         {"order": ["before", "after"], "ping": 0, "close": 2})


if __name__ == "__main__":
    main()
