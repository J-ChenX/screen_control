using Microsoft.EntityFrameworkCore;
using SyncClipboard.Server.Core.Models;
using SyncClipboard.Server.Core.Services.History;
using SyncClipboard.Server.Core.Utilities.History;
using SyncClipboard.Shared.Profiles;
using SyncClipboard.Shared.Profiles.Models;

// 只使用本次创建的临时数据库与附件，禁止接触现有用户历史。
var root = Path.Combine(Path.GetTempPath(), "screen-control-retention-" + Guid.NewGuid());
Directory.CreateDirectory(root);
var original = Directory.GetCurrentDirectory();
Directory.SetCurrentDirectory(root);
try
{
    await using var db = new HistoryDbContext();
    await db.Database.EnsureCreatedAsync();
    var now = new DateTime(2026, 9, 22, 0, 0, 0, DateTimeKind.Utc);
    var cutoff = now.AddHours(-48);
    HistoryRecordEntity Record(string hash, DateTime time, bool star = false, bool pin = false) => new()
    {
        UserId = HistoryService.HARD_CODED_USER_ID, Type = ProfileType.Text,
        Hash = hash, CreateTime = time, LastAccessed = time, LastModified = time,
        Stared = star, Pinned = pin, Version = 3
    };
    var old = Record("OLD", cutoff.AddTicks(-1));
    var star = Record("STAR", now.AddDays(-30), star: true);
    var pin = Record("PIN", now.AddDays(-30), pin: true);
    var edge = Record("EDGE", cutoff);
    var recent = Record("RECENT", cutoff.AddTicks(1));
    var future = Record("FUTURE", now.AddHours(1));
    var other = Record("OTHER", now.AddDays(-30)); other.UserId = "other";
    var deleted = Record("DELETED", now.AddDays(-30)); deleted.IsDeleted = true;
    db.AddRange(old, star, pin, edge, recent, future, other, deleted);
    await db.SaveChangesAsync();
    var env = new FixtureEnv(root);
    foreach (var r in new[] { old, star, pin })
    {
        var dir = Profile.QueryGetWorkingDir(root, r.Type, r.Hash);
        Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(Path.Combine(dir, "fixture.txt"), "隔离测试附件");
    }
    var service = new HistoryService(db, env, null!);
    void Check(bool value, string message) { if (!value) throw new Exception(message); }
    Check(await service.CleanupExpiredHistory(0, now) == 0, "关闭配置必须无副作用");
    Check(await service.CleanupExpiredHistory(48, now) == 2, "只删除超过边界的非收藏，置顶不豁免");
    Check(old.IsDeleted && pin.IsDeleted && old.Version == 4 && old.LastModified == now, "必须生成可同步的新版本删除标记");
    Check(!star.IsDeleted && !edge.IsDeleted && !recent.IsDeleted && !future.IsDeleted && !other.IsDeleted, "收藏、边界、新记录与其他用户必须保留");
    Check(!Directory.Exists(Profile.QueryGetWorkingDir(root, old.Type, old.Hash)), "过期附件应释放");
    Check(Directory.Exists(Profile.QueryGetWorkingDir(root, star.Type, star.Hash)), "收藏附件必须保留");
    Check(await service.CleanupExpiredHistory(48, now) == 0 && old.Version == 4, "重复清理必须幂等");
    // 离线客户端通过修改时间增量查询取得删除标记。
    var delta = await service.GetListAsync(HistoryService.HARD_CODED_USER_ID, 1, 50, modifiedAfter: now.AddSeconds(-1));
    Check(delta.Count(r => r.IsDeleted && (r.Hash == "OLD" || r.Hash == "PIN")) == 2, "离线增量查询必须返回删除标记");
    var race = Record("JUSTSTARRED", now.AddDays(-3)); db.Add(race); await db.SaveChangesAsync();
    var update = await service.Update(HistoryService.HARD_CODED_USER_ID, race.Type, race.Hash,
        new HistoryRecordUpdateDto { Starred = true, LastModified = now, Version = 4 });
    Check(update.Updated == true && await service.CleanupExpiredHistory(48, now) == 0 && !race.IsDeleted, "清理前完成的收藏必须保留");
    for (int i = 0; i < 205; i++) db.Add(Record("BATCH" + i, now.AddDays(-4)));
    await db.SaveChangesAsync();
    Check(await service.CleanupExpiredHistory(48, now) == 100, "首轮必须有界");
    Check(await service.CleanupExpiredHistory(48, now) == 100, "第二轮必须有界");
    Check(await service.CleanupExpiredHistory(48, now) == 5, "最后一轮应收敛");
    Check(!star.IsDeleted && !race.IsDeleted, "多批清理后收藏必须保留");
    // 复现旧内容再次复制：AddProfile 恢复删除标记和最近使用时间，创建时间仍旧。
    var repeatedProfile = new TextProfile("隔离服务端重复复制回归");
    var repeatedHash = await repeatedProfile.GetHash(CancellationToken.None);
    var repeated = Record(repeatedHash, now.AddDays(-6));
    repeated.Text = repeatedProfile.DisplayText; repeated.IsDeleted = true;
    db.Add(repeated); await db.SaveChangesAsync();
    await service.AddProfile(HistoryService.HARD_CODED_USER_ID, repeatedProfile, CancellationToken.None);
    var realNow=DateTime.UtcNow;
    Check(!repeated.IsDeleted && repeated.LastAccessed >= realNow.AddSeconds(-5), "重新复制没有恢复删除记录");
    await service.CleanupExpiredHistory(48, repeated.LastAccessed.AddHours(48));
    Check(!repeated.IsDeleted, "最近复制恰好48小时被误删");
    await service.CleanupExpiredHistory(48, repeated.LastAccessed.AddHours(48).AddTicks(1));
    Check(repeated.IsDeleted, "最近复制超过48小时后未过期");
    Console.WriteLine("通过：重新复制旧记录的48小时边界；48 小时边界、收藏与附件保护、置顶清除、用户隔离、幂等、删除版本/离线查询、收藏更新、100 条分批收敛");
}
finally
{
    Directory.SetCurrentDirectory(original);
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    Directory.Delete(root, recursive: true);
}
sealed class FixtureEnv(string root) : IProfileEnv
{
    public string GetPersistentDir() => root;
    public string GetHistoryPersistentDir() => root;
}
