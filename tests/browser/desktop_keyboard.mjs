// 验证真实的 MeshCentral 键盘协议，不发送远程输入。
// 用法：mise exec -- node tests/browser/desktop_keyboard.mjs /path/to/agent-desktop.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
  navigator: { platform: 'Linux' },
  urlargs: {},
  ShortToStr: (value) => String.fromCharCode(value >> 8, value & 255),
});
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), context);

function typeKeys(remoteKeyMap, keys) {
  const module = context.CreateAgentRemoteDesktop({ getContext: () => ({}) });
  module.State = 3;
  module.remoteKeyMap = remoteKeyMap;
  const packets = [];
  module.send = (packet) => packets.push([...packet].map((char) => char.charCodeAt(0)));
  for (const key of keys) {
    const event = {
      key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0), ctrlKey: false, altKey: false,
      preventDefault() {}, stopPropagation() {},
    };
    module.xxKeyDown(event);
    module.xxKeyPress(event);
    module.xxKeyUp(event);
  }
  return packets;
}

const keys = 'nihao ';
const windowsPackets = typeKeys(true, keys);
assert.deepEqual(windowsPackets, [...keys].flatMap((key) => [
  [0, 1, 0, 6, 0, key.toUpperCase().charCodeAt(0)],
  [0, 1, 0, 6, 1, key.toUpperCase().charCodeAt(0)],
]));
const defaultPackets = typeKeys(false, keys);
assert.equal(defaultPackets.length, keys.length * 2);
assert.ok(defaultPackets.every((packet) => packet[1] === 85));
console.log('PASS: Windows mode sends paired letter/space key events; default mode sends Unicode packets.');
