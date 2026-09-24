using Microsoft.EntityFrameworkCore;
using SyncClipboard.Core.Commons;
using SyncClipboard.Core.Models;
using SyncClipboard.Core.Models.UserConfigs;
using SyncClipboard.Core.Utilities.History;
using SyncClipboard.Shared.Profiles;
using SyncClipboard.Shared.Profiles.Models;

// 必须由测试命令提供独立配置目录，防止 Env 静态初始化访问真实配置。
var root = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
if (root is null || !Path.GetFileName(root).StartsWith("screen-control-retention-")) throw new Exception("需要隔离的 XDG_CONFIG_HOME");
var config = new ConfigManager(new StaticConfig(null!), null!);
config.SetConfig(new HistoryConfig { EnableHistory=true, EnableSyncHistory=true, MaxItemCount=0, HistoryRetentionMinutes=2880 });
var runtime = new ConfigBase(Path.Combine(root, "runtime.json"));
runtime.SetConfig(new RuntimeHistoryConfig { EnableSyncHistory=true });
var logger = new TestLogger();
var manager = new HistoryManager(config, logger, new FixtureEnv(root), runtime);
await using var db = new HistoryDbContext();
var now = DateTime.UtcNow;
HistoryRecord Row(string hash, int age, bool star=false, bool pin=false, HistorySyncStatus status=HistorySyncStatus.LocalOnly) => new()
{Hash=hash,Type=ProfileType.Text,Timestamp=now.AddHours(-age),Stared=star,Pinned=pin,SyncStatus=status};
db.AddRange(Row("OLD",49),Row("PIN",49,pin:true),Row("STAR",100,star:true),Row("RECENT",47),Row("SYNCED",100,status:HistorySyncStatus.Synced));
await db.SaveChangesAsync();
await manager.CleanupExpiredHistory();
db.ChangeTracker.Clear();
var kept=await db.HistoryRecords.Select(r=>r.Hash).OrderBy(r=>r).ToListAsync();
if (!kept.SequenceEqual(new[]{"RECENT","STAR","SYNCED"}) || logger.Errors!=0) throw new Exception("客户端本地独有记录清理或保护失败");
await manager.CleanupExpiredHistory();
if(await db.HistoryRecords.CountAsync()!=3) throw new Exception("客户端清理不幂等");
Console.WriteLine("通过：启用历史同步时仍清理过期 LocalOnly，保护收藏与新记录，Synced 由服务端处理");
sealed class FixtureEnv(string root) : IProfileEnv
{public string GetPersistentDir()=>root; public string GetHistoryPersistentDir()=>root;}
sealed class TestLogger : SyncClipboard.Core.Interfaces.ILogger
{
 public int Errors;
 public void Write(string? tag,string str){if(str.Contains("Error")) Errors++;}
 public void Write(string str)=>Write(null,str);
 public Task WriteAsync(string? tag,string str){Write(tag,str);return Task.CompletedTask;}
 public Task WriteAsync(string str)=>WriteAsync(null,str);
 public void Flush(){}
}
