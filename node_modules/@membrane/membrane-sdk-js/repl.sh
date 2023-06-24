#!/bin/sh

while [ 1 ] ; do
    node --no-deprecation -r ./repl.js 2>&1 # | grep -E --color 'node_modules|$'
    echo Restarting repl...
    sleep 2
done
