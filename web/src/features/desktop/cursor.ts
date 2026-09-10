// MeshCentral 协议 88 的光标 4 映射为 help；控屏统一显示普通箭头。
// 保留文本、链接、缩放等反馈，未知编号也回退箭头。
export function normalizeCursorCommand(command: number, size: number, data: Uint8Array): Uint8Array {
  if (command !== 88 || size !== 5 || data.length !== 5 || (data[4] !== 4 && data[4] < 21)) return data;
  const normalized = data.slice();
  normalized[4] = 0;
  return normalized;
}
