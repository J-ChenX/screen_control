using System.Reflection;
using System.Runtime.Loader;
using System.IO.Compression;
using System.Buffers.Binary;

// 通过实际安装的应用宿主启动；仅处理合成图像，不访问系统剪贴板或历史。
var root = AppContext.BaseDirectory;
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var path = Path.Combine(root, name.Name + ".dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var core = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(root, "SyncClipboard.Core.dll"));
foreach (var reference in core.GetReferencedAssemblies().Where(x => x.Name!.StartsWith("Magick.NET")))
{
    var loaded = Assembly.Load(reference);
    if (loaded.GetName().Version != reference.Version) throw new Exception("图像程序集版本不匹配");
    Console.WriteLine("已解析图像依赖：" + reference.Name);
}
// 生成带正确 CRC 的 2×2 RGBA PNG，同时验证原生解码和重新编码路径。
using var png = new MemoryStream();
png.Write(new byte[] {137,80,78,71,13,10,26,10});
void Chunk(string kind, byte[] payload)
{
    var name = System.Text.Encoding.ASCII.GetBytes(kind);
    Span<byte> integer = stackalloc byte[4];
    BinaryPrimitives.WriteInt32BigEndian(integer, payload.Length); png.Write(integer); png.Write(name); png.Write(payload);
    uint crc = 0xffffffff;
    foreach (byte b in name.Concat(payload)) { crc ^= b; for (int n=0;n<8;n++) crc=(crc>>1)^((crc&1)!=0?0xedb88320u:0); }
    BinaryPrimitives.WriteUInt32BigEndian(integer, ~crc); png.Write(integer);
}
Chunk("IHDR",new byte[]{0,0,0,2,0,0,0,2,8,6,0,0,0});
using var compressed = new MemoryStream();
using (var zip = new ZLibStream(compressed, CompressionLevel.Optimal, true))
    zip.Write(new byte[]{0,255,0,0,255,0,255,0,255,0,0,0,255,255,255,255,255,255});
Chunk("IDAT",compressed.ToArray()); Chunk("IEND",Array.Empty<byte>());
var type = core.GetType("SyncClipboard.Core.Utilities.ClipboardImage",true)!;
var image = type.GetMethod("TryCreateImage")!.Invoke(null,new object[]{png.ToArray()});
if (image is null) throw new Exception("已安装环境无法解码PNG");
var saved = await (Task<byte[]>)type.GetMethod("SaveToBytes")!.Invoke(image,new object[]{CancellationToken.None})!;
if (saved.Length < 24 || BinaryPrimitives.ReadInt32BigEndian(saved.AsSpan(16,4))!=2 || BinaryPrimitives.ReadInt32BigEndian(saved.AsSpan(20,4))!=2)
    throw new Exception("图像重新编码尺寸错误");
Console.WriteLine("已安装宿主、托管/原生依赖、PNG解码与重新编码通过");
