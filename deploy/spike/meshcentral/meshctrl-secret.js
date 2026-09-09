"use strict";

// 运行 MeshCentral 上游 meshctrl 命令行工具，避免将登录密码放入
// 原生进程参数或环境变量。调用方必须将权限为 0600 的
// 密码文件以只读方式挂载到下方固定路径。

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`meshctrl-secret: ${message}\n`);
  process.exit(1);
}

const secretPath = "/run/secrets/loginpass";
let raw;
try {
  raw = fs.readFileSync(secretPath);
} catch (error) {
  fail(`cannot read ${secretPath}`);
}

let end = raw.length;
while (end > 0 && (raw[end - 1] === 10 || raw[end - 1] === 13)) end -= 1;
if (end < 16 || end > 256 || raw.subarray(0, end).includes(0)) {
  raw.fill(0);
  fail("password must contain 16 to 256 non-NUL UTF-8 bytes");
}

let password = raw.subarray(0, end).toString("utf8");
raw.fill(0);

const meshctrl = path.join(__dirname, "node_modules", "meshcentral", "meshctrl.js");
const forwarded = process.argv.slice(2);
if (forwarded.some((value) => value === "--loginpass" || value.startsWith("--loginpass="))) {
  password = undefined;
  fail("callers must not supply --loginpass");
}

// 替换 JavaScript 的 argv 数组不会改变 /proc/<pid>/cmdline。
// 明文仅存在于当前进程内，由固定版本的命令行工具使用。
process.argv = [process.execPath, meshctrl, ...forwarded, "--loginpass", password];
password = undefined;
require(meshctrl);
