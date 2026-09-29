using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Microsoft.Extensions.DependencyInjection;
using SyncClipboard.Core.Clipboard;
using SyncClipboard.Core.Commons;
using SyncClipboard.Core.Interfaces;
using SyncClipboard.Core.Models.UserConfigs;
using SyncClipboard.Core.Utilities.FileCacheManager;
using SyncClipboard.Core.Utilities.History;
using SyncClipboard.Core.ViewModels;
using SyncClipboard.Desktop.ClipboardAva.ClipboardReader;
using SyncClipboard.Shared.Profiles;
using SyncClipboard.Shared.Profiles.Models;

class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (Environment.GetEnvironmentVariable("SCREEN_CONTROL_ISOLATED_CLIPBOARD") != "1")
            throw new Exception("仅允许在测试创建的独立Xvfb中运行");
        return AppBuilder.Configure<FixtureApp>().UsePlatformDetect().StartWithClassicDesktopLifetime(args);
    }
}
class FixtureApp : Application
{
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted();
        var lifetime=(IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!;
        var window=new FixtureWindow {Width=120,Height=80}; lifetime.MainWindow=window;
        window.Opened+=async (_,_)=>{
            try
            {
                await Task.Delay(500);
                var root=Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")!;
                var logger=new QuietLogger();
                var config=new ConfigManager(new StaticConfig(null!),null!);
                config.SetConfig(new HistoryConfig{EnableHistory=true,EnableSyncHistory=false,MaxItemCount=100,HistoryRetentionMinutes=2880});
                var runtime=new ConfigBase(Path.Combine(root,"fixture-runtime.json"));
                var env=new FixtureEnv(Path.Combine(root,"fixture-files"));
                Directory.CreateDirectory(env.GetPersistentDir());
                var services=new ServiceCollection();
                services.AddSingleton<SyncClipboard.Core.Interfaces.ILogger>(logger);
                services.AddSingleton(config);services.AddSingleton<IProfileEnv>(env);
                services.AddSingleton<LocalFileCacheManager>();
                services.AddSingleton<MultiSourceClipboardReader>(_=>new MultiSourceClipboardReader(new[]{new AvaloniaClipboardReader(window)},config));
                using var sp=services.BuildServiceProvider();
                var factoryType=typeof(AvaloniaClipboardReader).Assembly.GetType("SyncClipboard.Desktop.ClipboardAva.ClipboardFactory",true)!;
                var factory=(IClipboardFactory)Activator.CreateInstance(factoryType,sp)!;
                using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var meta=await factory.GetMetaInfomation(timeout.Token);
                var profile=await factory.CreateProfileFromMeta(meta,true,timeout.Token);
                if(profile.Type!=ProfileType.Image)throw new Exception("X11图片未被识别为图像");
                var manager=new HistoryManager(config,logger,env,runtime);
                await manager.AddLocalProfile(profile,token:timeout.Token);
                var history=await manager.GetHistory(timeout.Token);
                if(history.Count!=1 || history[0].Type!=ProfileType.Image || history[0].IsDeleted || !history[0].IsLocalFileReady)
                    throw new Exception("图片没有完整进入隔离历史数据库");
                Console.WriteLine("通过：跨进程X11图片读取、实际ClipboardFactory解析、图片缓存及历史入库");
                lifetime.Shutdown(0);
            }
            catch(Exception e){Console.Error.WriteLine(e);lifetime.Shutdown(1);}
        };
    }
}
class FixtureWindow:Window,IMainWindow
{
    public void NavigateTo(PageDefinition page,NavigationTransitionEffect effect,object? para){}
    public void OpenPage(PageDefinition page,object? para=null){}
    public void NavigateToLastLevel(){}
    public void NavigateToNextLevel(PageDefinition page,object? para){}
    public void SetFont(string font){}
    public void ExitApp(){}
}
sealed class FixtureEnv(string root):IProfileEnv
{
    public string GetPersistentDir()=>root;
    public string GetHistoryPersistentDir()=>root;
}
sealed class QuietLogger:SyncClipboard.Core.Interfaces.ILogger
{
    public void Write(string? tag,string str){} public void Write(string str){}
    public Task WriteAsync(string? tag,string str)=>Task.CompletedTask;
    public Task WriteAsync(string str)=>Task.CompletedTask;public void Flush(){}
}
