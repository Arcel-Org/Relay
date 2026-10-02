#!/bin/sh
# Filters Next.js's "middleware file convention is deprecated, use proxy"
# warning from build output. proxy.ts is broken in several deployment
# shapes on Next 16.2.10, including specifically behind Cloudflare Proxy
# (https://github.com/vercel/next.js/issues/86122) -- middleware.ts is the
# correct file here, confirmed working. Remove this wrapper once that's
# fixed upstream and we migrate to proxy.ts for real.
#
# Exit code is taken from the wrapped command, not from grep, so a real
# build failure still propagates correctly even though its output passes
# through a pipe.
status_file="/tmp/.quiet-deprecation-status.$$"
( "$@"; echo $? > "$status_file" ) 2>&1 | grep -v 'The "middleware" file convention is deprecated'
status=$(cat "$status_file")
rm -f "$status_file"
exit "$status"
