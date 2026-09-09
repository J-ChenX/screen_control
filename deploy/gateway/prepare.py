#!/usr/bin/env python3
"""准备私有网关凭据和隧道配置，不执行发布。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True, help='Exact public HTTPS origin, e.g. https://remote.your-domain.com')
    parser.add_argument('--directory', type=Path, default=Path.home() / '.config/screen-control/gateway')
    args = parser.parse_args()
    u = urlsplit(args.origin)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password or u.path or u.query or u.fragment
            or u.port not in (None, 443) or any(c.isspace() for c in args.origin)):
        parser.error('--origin must be an HTTPS hostname on port 443, without a path')
    root = args.directory.expanduser().resolve()
    if root.exists():
        parser.error('directory already exists; refusing to replace credentials')
    os.umask(0o077)
    root.mkdir(parents=True, mode=0o700)
    credentials = []
    for device in ('echova', 'nix', 'jiang-chenx'):
        key = secrets.token_hex(32)
        (root / f'{device}.key').write_text(key + '\n')
        credentials.append({'deviceId': device, 'sha256': hashlib.sha256(key.encode()).hexdigest()})
    hashes = root / 'credentials.json'
    hashes.write_text(json.dumps(credentials, indent=2) + '\n')
    (root / 'gateway.env').write_text(
        'SCREEN_CONTROL_GATEWAY_LISTEN=127.0.0.1:8791\n'
        f'SCREEN_CONTROL_GATEWAY_ORIGIN={args.origin}\n'
        f'SCREEN_CONTROL_GATEWAY_CREDENTIALS="{hashes}"\n')
    # 命名隧道的凭据和隧道 ID 由运维人员提供。
    (root / 'cloudflared.yml.example').write_text(
        'tunnel: REPLACE_WITH_TUNNEL_ID\n'
        'credentials-file: REPLACE_WITH_TUNNEL_CREDENTIAL_FILE\n'
        'ingress:\n'
        f'  - hostname: {u.hostname}\n'
        '    service: http://127.0.0.1:8791\n'
        '    originRequest:\n'
        f'      httpHostHeader: {u.netloc}\n'
        '  - service: http_status:404\n')
    print(f'Prepared private files in {root}; nothing has been published.')
    print('Access keys were saved to per-device .key files and were not printed.')


if __name__ == '__main__':
    main()
