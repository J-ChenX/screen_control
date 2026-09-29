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
{Hash=hash,Type=ProfileType.Text,Timestamp=now.AddHours(-age),LastAccessed=now.AddHours(-age),Stared=star,Pinned=pin,SyncStatus=status};
db.AddRange(Row("OLD",49),Row("PIN",49,pin:true),Row("STAR",100,star:true),Row("RECENT",47),Row("SYNCED",100,status:HistorySyncStatus.Synced));
await db.SaveChangesAsync();
await manager.CleanupExpiredHistory();
db.ChangeTracker.Clear();
var kept=await db.HistoryRecords.Select(r=>r.Hash).OrderBy(r=>r).ToListAsync();
if (!kept.SequenceEqual(new[]{"RECENT","STAR","SYNCED"}) || logger.Errors!=0) throw new Exception("客户端本地独有记录清理或保护失败");
await manager.CleanupExpiredHistory();
if(await db.HistoryRecords.CountAsync()!=3) throw new Exception("客户端清理不幂等");
// 被清理过的旧文本重新复制后必须恢复，并从最近使用时间重新保留。
var profile = new TextProfile("隔离重复复制回归");
var hash = await profile.GetHash(CancellationToken.None);
var recopied = Row(hash, 100); recopied.Text = profile.DisplayText; recopied.IsDeleted = true;
db.Add(recopied); await db.SaveChangesAsync();
await manager.AddLocalProfile(profile);
await manager.CleanupExpiredHistory();
db.ChangeTracker.Clear();
var restored = await db.HistoryRecords.SingleAsync(r => r.Hash == hash);
if (restored.IsDeleted || restored.LastAccessed < now || restored.Timestamp > now.AddHours(-99))
    throw new Exception("旧文本重新复制后未恢复或仍按首次创建时间清理");
// 收藏等元数据更新不应单独延长内容保留期。
var metadataOnly=Row("METADATAONLY",100);metadataOnly.LastModified=DateTime.UtcNow;
db.Add(metadataOnly);await db.SaveChangesAsync();await manager.CleanupExpiredHistory();
db.ChangeTracker.Clear();
if(await db.HistoryRecords.AnyAsync(r=>r.Hash=="METADATAONLY"))throw new Exception("元数据更新时间错误延长保留期");
Console.WriteLine("通过：旧文本重新复制恢复并保留，元数据更新不延长过期时间；启用历史同步时仍清理过期 LocalOnly，保护收藏与新记录，Synced 由服务端处理");
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
