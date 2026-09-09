"use strict";

// 一次性 G0 账号创建工具。明文仅从标准输入传入，并使用
// MeshCentral 1.2.5 自身的密码算法计算哈希，绝不写入原生
// 进程命令行、环境变量、配置、URL 或输出。

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`provision: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--user" || !/^[A-Za-z0-9_.-]{1,64}$/.test(args[1])) {
  fail("usage: provision.js --user <safe-user-name>");
}
if (process.stdin.isTTY) {
  fail("password must arrive on a non-TTY stdin descriptor");
}

const raw = fs.readFileSync(0);
let end = raw.length;
while (end > 0 && (raw[end - 1] === 10 || raw[end - 1] === 13)) end -= 1;
if (end < 16 || end > 256 || raw.subarray(0, end).includes(0)) {
  raw.fill(0);
  fail("password must contain 16 to 256 non-NUL UTF-8 bytes");
}

let password = raw.subarray(0, end).toString("utf8");
raw.fill(0);
const meshRoot = path.join(__dirname, "node_modules", "meshcentral");
const hashPassword = require(path.join(meshRoot, "pass.js")).hash;

hashPassword(password, (error, salt, hash) => {
  password = undefined;
  if (error || typeof salt !== "string" || typeof hash !== "string" || salt.includes(",") || hash.includes(",")) {
    fail("MeshCentral password hashing failed");
  }

  // 修改 JavaScript 的 argv 数组不会改变 /proc/<pid>/cmdline。
  // 仅将派生的密码验证值交给 MeshCentral 文档规定的账号
  // 创建流程；此包装脚本绝不打印该值。
  const meshMain = path.join(meshRoot, "meshcentral.js");
  process.argv = [process.execPath, meshMain, "--createaccount", args[1], "--hashpass", `${salt},${hash}`];
  require(meshMain).mainStart();
}, 0);
