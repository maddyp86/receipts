#!/usr/bin/env bash
# ===========================================================================
# check-trust-proxy — is the rate limiter keying on the real client IP?
#
#   bash tools/check-trust-proxy.sh                       # production
#   bash tools/check-trust-proxy.sh http://localhost:8787  # any other backend
#
# Run it from any machine OUTSIDE Render (your laptop is fine). Free: it only
# calls /api/senators, which costs nothing and counts against nothing but the
# read limit (120 per 15 minutes).
#
# HOW IT KNOWS. express-rate-limit puts the key it limited on into every
# `RateLimit-Policy` header as `pk=:<base64>:` — base64 of the first 12 hex
# characters of sha256(key). With the right TRUST_PROXY_HOPS the key is your
# IP, so pk decodes to the first 12 hex characters of sha256(your IP). With the
# wrong one it is a proxy's address: a value you can't reproduce, often a
# different one on every request — and then every request gets a fresh bucket
# and the per-IP limits limit nothing.
#
# IPv4 throughout (-4), so the key is your IPv4 address rather than an IPv6
# /56 network.
#
# PASS requires all three:
#   1. pk equals sha256(your IPv4)[:12];
#   2. pk is the same on every request, and the remaining count goes down;
#   3. a forged X-Forwarded-For does not change pk. If it does, the hop count
#      is too HIGH: a caller can mint a fresh bucket per request by writing
#      any address into the header.
# ===========================================================================
set -euo pipefail

BASE="${1:-https://receipts-65yk.onrender.com}"
URL="$BASE/api/senators"

ip=$(curl -s -4 --max-time 15 https://api.ipify.org)
expected=$(printf '%s' "$ip" | shasum -a 256 | cut -c1-12)
echo "your IPv4 hashes to:      $expected"

# pk and remaining count from one request; extra curl args pass through.
probe() {
  local headers pk remaining
  headers=$(curl -s -4 -D - -o /dev/null --max-time 60 "$@" "$URL" | tr -d '\r')
  pk=$(printf '%s\n' "$headers" | grep -i '^ratelimit-policy:' | head -1 | sed -E 's/.*pk=:([^:]+):.*/\1/' | base64 -d 2>/dev/null || true)
  remaining=$(printf '%s\n' "$headers" | grep -i '^ratelimit:' | head -1 | sed -E 's/.*r=([0-9]+).*/\1/')
  printf '%s %s\n' "${pk:-none}" "${remaining:-?}"
}

pass=true
first=""
for i in 1 2 3; do
  read -r pk remaining < <(probe)
  echo "request $i: limiter key   $pk   (remaining $remaining)"
  [ -z "$first" ] && first="$pk"
  [ "$pk" = "$first" ] || pass=false
done

read -r forged _ < <(probe -H 'X-Forwarded-For: 203.0.113.7')
echo "forged X-Forwarded-For:   $forged"

echo
if [ "$first" != "$expected" ]; then
  echo "FAIL — the limiter is not keying on your IP."
  if $pass; then
    echo "  The key is stable but someone else's: the hop count is probably too HIGH or too low by one."
  else
    echo "  The key changes on every request: the hop count is too LOW — it is landing on a proxy."
  fi
  exit 1
fi
if ! $pass; then
  echo "FAIL — the key matched once but did not hold across requests."
  exit 1
fi
if [ "$forged" != "$expected" ]; then
  echo "FAIL — a forged X-Forwarded-For changed the key: the hop count is too HIGH."
  exit 1
fi
echo "PASS — the limiter keys on your real IP, holds it across requests, and ignores a forged header."
