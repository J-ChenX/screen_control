"""本地 HTTPS 浏览器冒烟检查；模拟桌面协议，不发送远程输入。
在 make build 之后运行，需要 Chrome 和前端开发依赖。
"""
import hashlib,http.client,http.server,json,os,pathlib,secrets,ssl,subprocess,tempfile,threading,time
repo=pathlib.Path(__file__).resolve().parents[2]
(repo/'evidence').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='screen-control-gateway-qa-') as tmp:
 p=pathlib.Path(tmp);os.chmod(p,0o700);key=secrets.token_hex(32)
 creds=p/'credentials.json';creds.write_text(json.dumps([{'deviceId':'nix','sha256':hashlib.sha256(key.encode()).hexdigest()}]));creds.chmod(0o600)
 (p/'key').write_text(key);(p/'key').chmod(0o600)
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(p/'key.pem'),'-out',str(p/'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 log=open(p/'server.log','w')
 process=subprocess.Popen([str(repo/'bin/screen-control'),'--serve','--listen','127.0.0.1:18790','--gateway-listen','127.0.0.1:18791','--gateway-origin','https://127.0.0.1:18792','--gateway-credentials',str(creds),'--portal-dir',str(repo/'dist/portal')],stdout=log,stderr=log)
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
   try:
    c=http.client.HTTPConnection('127.0.0.1',18790,timeout=1);c.request('GET','/api/v1/health');c.getresponse().read();c.close();break
   except OSError:time.sleep(.1)
  script=p/'browser.mjs';script.write_text(r'''
import {createRequire} from 'node:module';import fs from 'node:fs';
const require=createRequire(process.env.TEST_REPO+'/web/package.json');const {chromium,expect}=require('@playwright/test');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try {
 const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 const origin='https://127.0.0.1:18792';const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/vendor/**',async route=>route.fulfill({contentType:'text/javascript',body:`
 window.CreateAgentRemoteDesktop=()=>({KeyAction:{SCROLL:1,DOWN:1,UP:2},GrabMouseInput(){},GrabKeyInput(){},UnGrabMouseInput(){},UnGrabKeyInput(){},SendMouseMsg(){}});
 window.CreateAgentRedirect=(_a,m)=>{const r={m,Start(){setTimeout(()=>r.onStateChanged(r,3),10)},Stop(){r.onStateChanged(r,0)}};window.testDisconnect=()=>r.onStateChanged(r,0);return r;};
 `}));
 await page.goto(origin);await expect(page.getByRole('heading',{name:'登录私人远控'})).toBeVisible();
 await page.screenshot({path:process.env.TEST_REPO+'/evidence/gateway-login.png',fullPage:true});
 await page.getByLabel('设备访问密钥').fill(fs.readFileSync(process.env.TEST_KEY_FILE,'utf8'));await page.getByRole('button',{name:'验证并进入'}).click();
 await expect(page.getByRole('button',{name:'退出登录'})).toBeVisible();
 const identity=await page.evaluate(()=>fetch('/api/v1/identity/device').then(r=>r.json()));if(identity.data.deviceId!=='nix'||identity.data.accessMode!=='gateway')throw Error('wrong identity');
 let created=0;
 await page.route('**/api/v1/desktops',route=>{created++;return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({apiVersion:'v1',data:{desktopSessionId:'test-'+created,nodeId:'node/server',tunnelId:'test',relayPath:'/api/v1/desktops/test/relay',state:'connecting'}})})});
 await page.route('**/api/v1/desktops/*/end',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({apiVersion:'v1',data:{state:'ended'}})}));
 await page.goto(origin+'/devices/echova/desktop');await expect(page.getByText('实机桌面已连接',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.testDisconnect());await expect.poll(()=>created).toBe(2);await expect(page.getByText('实机桌面已连接',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'结束连接',exact:true}).click();await page.waitForTimeout(2200);if(created!==2)throw Error('manual stop reconnected');
 await page.goto(origin+'/settings/security');await page.getByRole('button',{name:'退出登录'}).first().click();await expect(page.getByRole('heading',{name:'登录私人远控'})).toBeVisible();
 const result=await context.request.get(origin+'/api/v1/health');if(result.status()!==401)throw Error('logout did not revoke');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Browser PASS: HTTPS login, registered identity, mocked desktop reconnect, manual stop, logout and revoked API.');
}finally{await browser.close()}
''')
  env=dict(os.environ,TEST_KEY_FILE=str(p/'key'),TEST_REPO=str(repo))
  subprocess.run(['mise','exec','--','node',str(script)],cwd=repo,env=env,check=True)
 finally:
  proxy.shutdown();process.terminate();process.wait(timeout=10);log.close()
