#!/bin/bash
cd /tmp/fake
PHP_CLI_SERVER_WORKERS=4 setsid nohup php -S 127.0.0.1:9001 fake.php </dev/null >/tmp/fake/srv1.log 2>&1 &
cd /tmp/saltest
APP_PASSWORD=pw GEMINI_API_KEY=k GEMINI_ENDPOINT='http://127.0.0.1:9001/%s:generateContent' PHP_CLI_SERVER_WORKERS=4 setsid nohup php -S 127.0.0.1:9002 </dev/null >/tmp/fake/srv2.log 2>&1 &
disown -a
exit 0
