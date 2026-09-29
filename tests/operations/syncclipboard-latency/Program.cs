using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.AspNetCore.SignalR;
using SyncClipboard.Core.Interfaces;
using SyncClipboard.Core.Models.UserConfigs;
using SyncClipboard.Core.RemoteServer;
using SyncClipboard.Core.RemoteServer.Adapter.OfficialServer;
using SyncClipboard.Core.RemoteServer.Adapter.WebDavServer;
using SyncClipboard.Shared;

static async Task Until(Func<bool> condition, string message, int timeout = 5000)
{
    var watch=Stopwatch.StartNew();
    while(!condition()) { if(watch.ElapsedMilliseconds>timeout) throw new Exception(message); await Task.Delay(20); }
}
static void Check(bool ok,string message) { if(!ok) throw new Exception(message); }
// 一次异常不能永久停止健康检查；重复启动及结束后不得再通知。
int calls=0,success=0;
using(var alive=new TestAliveHelper(_=>Interlocked.Increment(ref calls)==1 ? Task.FromException<bool>(new IOException("测试瞬时错误")) : Task.FromResult(true),TimeSpan.FromMilliseconds(20)))
{
    alive.TestSuccessed+=()=>Interlocked.Increment(ref success);alive.Restart();
    await Until(()=>Volatile.Read(ref success)>=2,"异常后检查未恢复");
    alive.Dispose();var stopped=success;await Task.Delay(100);Check(success==stopped,"结束后仍收到健康回调");
    alive.Restart();await Task.Delay(100);Check(success==stopped,"结束后允许重新启动");
}
int concurrent=0,peak=0;
using(var alive=new TestAliveHelper(async ct=>{var n=Interlocked.Increment(ref concurrent);peak=Math.Max(peak,n);try {await Task.Delay(100,ct);return true;}finally{Interlocked.Decrement(ref concurrent);}},TimeSpan.FromMilliseconds(10)))
{
    alive.Restart();await Task.Delay(250);Check(peak==1,"健康检查出现并行积压");
}
await Until(()=>Volatile.Read(ref concurrent)==0,"结束后检查未退出");
Console.WriteLine("健康检查异常恢复、停止和串行检查通过");

// 真实回环 SignalR：模拟远端断开并检查连接/通知资源释放，不使用生产账号或剪贴板。
var builder=WebApplication.CreateBuilder();builder.Logging.ClearProviders();builder.WebHost.UseUrls("http://127.0.0.1:0");builder.Services.AddSignalR();
await using var app=builder.Build();app.MapHub<ProbeHub>("/SyncClipboardHub");await app.StartAsync();
var url=app.Urls.Single();var logger=new QuietLogger();var cfg=new AppConfig();var dav=new WebDavAdapter(logger,cfg);
var adapter=new OfficialAdapter(logger,cfg,dav);int connected=0,received=0,disconnected=0;
adapter.ServerConnected+=()=>Interlocked.Increment(ref connected);
adapter.ServerDisconnected+=_=>Interlocked.Increment(ref disconnected);
adapter.ProfileDtoChanged+=_=>Interlocked.Increment(ref received);
adapter.SetConfig(new OfficialConfig{RemoteURL=url,UserName="test",Password="isolated-test"},new SyncConfig());
adapter.ApplyConfig();
using var reconnectProbe=new TestAliveHelper(_=>Task.FromResult(true));
reconnectProbe.TestSuccessed+=adapter.StartListening;reconnectProbe.Restart();
await Until(()=>connected==1&&ProbeHub.Active.Count==1,"初始通知连接失败");
for(int i=0;i<20;i++)adapter.StartListening();await Task.Delay(200);Check(connected==1&&ProbeHub.Active.Count==1,"健康检查重复创建通知连接");
var watch=Stopwatch.StartNew();foreach(var connection in ProbeHub.Active.Values.ToArray())connection.Abort();
await Until(()=>connected>=2&&ProbeHub.Active.Count==1,"自动重连未完成");
var reconnectMs=watch.ElapsedMilliseconds;
var hub=app.Services.GetRequiredService<IHubContext<ProbeHub>>();await hub.Clients.All.SendAsync("RemoteProfileChanged",new ProfileDto{Text="隔离通知测试"});
await Until(()=>received==1,"重连后通知未恢复");await Task.Delay(100);Check(received==1,"旧连接重复触发通知");
for(int i=0;i<10;i++)adapter.ApplyConfig();
await Until(()=>ProbeHub.Active.Count==1&&connected>=3,"替换配置后连接未收敛");
reconnectProbe.Dispose();
var beforeStop=disconnected;adapter.StopListening();await Until(()=>ProbeHub.Active.IsEmpty,"停止后服务端连接未释放");
await Task.Delay(150);Check(disconnected==beforeStop,"旧连接关闭污染新状态");
adapter.StartListening();await Until(()=>ProbeHub.Active.Count==1,"停止后无法重新监听");
adapter.Dispose();await Until(()=>ProbeHub.Active.IsEmpty,"Dispose 后仍有通知连接");adapter.StartListening();await Task.Delay(150);Check(ProbeHub.Active.IsEmpty,"Dispose 后重新创建连接");
Console.WriteLine($"真实 SignalR 断线恢复通过，恢复耗时 {reconnectMs}ms；重复监听、10 次配置替换、停止释放及过期回调隔离通过");
await app.StopAsync();

public sealed class ProbeHub:Hub
{
    public static readonly ConcurrentDictionary<string,HubCallerContext> Active=new();
    public override Task OnConnectedAsync(){Active[Context.ConnectionId]=Context;return base.OnConnectedAsync();}
    public override Task OnDisconnectedAsync(Exception? error){Active.TryRemove(Context.ConnectionId,out _);return base.OnDisconnectedAsync(error);}
}
public sealed class QuietLogger:SyncClipboard.Core.Interfaces.ILogger
{
    public void Write(string? tag,string str){} public void Write(string str){}
    public Task WriteAsync(string? tag,string str)=>Task.CompletedTask;public Task WriteAsync(string str)=>Task.CompletedTask;public void Flush(){}
}
public sealed class AppConfig:IAppConfig
{
    public string AppId=>"test";public string AppStringId=>"test";public string AppVersion=>"3.1.5";public string UpdateApiUrl=>"";public string UpdateUrl=>"";
}
