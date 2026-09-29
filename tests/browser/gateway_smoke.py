"""本地 HTTPS 浏览器冒烟检查；模拟桌面协议，不发送远程输入。
在 make build 之后运行，需要锁定 Playwright 的 Chromium 和前端开发依赖。
"""
import hashlib,http.client,http.server,json,os,pathlib,secrets,ssl,subprocess,tempfile,threading,time
repo=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='screen-control-gateway-qa-') as tmp:
 p=pathlib.Path(tmp);os.chmod(p,0o700);key=secrets.token_hex(32)
 creds=p/'credentials.json';creds.write_text(json.dumps([{'deviceId':'nix','sha256':hashlib.sha256(key.encode()).hexdigest()}]));creds.chmod(0o600)
 (p/'key').write_text(key);(p/'key').chmod(0o600)
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(p/'key.pem'),'-out',str(p/'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log=open(p/'server.log','w')
 # 后端仅使用临时配置，禁止继承真实 MeshCentral、文件通道与收藏路径。
 isolated_env={name:value for name,value in os.environ.items() if not name.startswith('SCREEN_CONTROL_')}
 process=subprocess.Popen([str(repo/'bin/screen-control'),'--serve','--listen','127.0.0.1:18790','--gateway-listen','127.0.0.1:18791','--gateway-origin','https://127.0.0.1:18792','--gateway-credentials',str(creds),'--portal-dir',str(repo/'dist/portal'),'--mesh-url','http://127.0.0.1:1','--mesh-password-file',str(p/'key'),'--mesh-file-password-file',str(p/'key'),'--favorites-file',str(p/'favorites.json')],env=isolated_env,stdout=log,stderr=log)
 class Proxy(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_GET(self):self.proxy()
  def do_POST(self):self.proxy()
  def proxy(self):
   body=self.rfile.read(int(self.headers.get('Content-Length','0')))
   c=http.client.HTTPConnection('127.0.0.1',18791,timeout=20)
   try:
    c.request(self.command,self.path,body,dict(self.headers));r=c.getresponse();data=r.read();self.send_response(r.status)
    for k,v in r.getheaders():
     if k.lower() not in ('connection','transfer-encoding','content-length'):self.send_header(k,v)
    self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
   finally:c.close()
 proxy=http.server.ThreadingHTTPServer(('127.0.0.1',18792),Proxy);tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(p/'cert.pem',p/'key.pem');proxy.socket=tls.wrap_socket(proxy.socket,server_side=True)
 threading.Thread(target=proxy.serve_forever,daemon=True).start()
 try:
  for _ in range(50):
   if process.poll() is not None:raise RuntimeError('隔离网关进程启动失败')
   try:
    c=http.client.HTTPConnection('127.0.0.1',18790,timeout=1);c.request('GET','/api/v1/health');c.getresponse().read();c.close();break
   except OSError:time.sleep(.1)
  else:raise RuntimeError('隔离网关健康检查超时')
  env=dict(os.environ,TEST_KEY_FILE=str(p/'key'))
  subprocess.run(['mise','exec','--','node',str(repo/'tests/browser/gateway-smoke.mjs')],cwd=repo,env=env,check=True)
 finally:
  proxy.shutdown();process.terminate();process.wait(timeout=10);log.close()
